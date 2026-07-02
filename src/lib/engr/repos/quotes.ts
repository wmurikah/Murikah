/**
 * Quote repository: an invited contractor submits or declines, and the engineer
 * marks a preferred quote. Totals are always computed server-side from the line
 * items; a client-supplied total is never trusted. A contractor may act only
 * through an invitation addressed to their own contractor and may read only
 * their own quote. Org-scoped throughout; quote status here is not a work-order
 * status, so it does not go through the state machine.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { contractorForUser } from './techniciansPick';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export interface QuoteItemInput {
  description: string;
  unit: string | null;
  qty: number;
  unitRateMinor: number;
  isSpare: boolean;
  categoryId: string | null;
}

export interface SubmitQuoteInput {
  diagnosis: string | null;
  proposedSolution: string | null;
  siteVisitDone: boolean;
  items: QuoteItemInput[];
}

export type QuoteActionResult =
  | { ok: true; quoteId?: string; quoteNo?: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict' | 'invalid'; message: string };

async function countQuoteForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM quotes WHERE org_id = ? AND quote_no LIKE ?`,
    args: [orgId, `QT-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

interface RfqOwner {
  status: string;
  createdBy: string;
  rfqNo: string;
}

async function loadRfqOwner(db: Client, orgId: string, rfqId: string): Promise<RfqOwner | null> {
  const res = await db.execute({
    sql: `SELECT status, created_by, rfq_no FROM rfqs WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [rfqId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    status: String(row.status),
    createdBy: String(row.created_by),
    rfqNo: String(row.rfq_no),
  };
}

export async function submitQuote(
  db: Client,
  ctx: { orgId: string; userId: string },
  rfqId: string,
  input: SubmitQuoteInput,
): Promise<QuoteActionResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };

  const invRes = await db.execute({
    sql: `SELECT status FROM rfq_invitations
           WHERE org_id = ? AND rfq_id = ? AND contractor_id = ? LIMIT 1`,
    args: [orgId, rfqId, contractorId],
  });
  const invitation = invRes.rows[0];
  if (!invitation)
    return { ok: false, code: 'forbidden', message: 'You are not invited to this RFQ.' };
  if (String(invitation.status) === 'DECLINED') {
    return { ok: false, code: 'conflict', message: 'You have declined this RFQ.' };
  }
  if (String(invitation.status) === 'QUOTED') {
    return { ok: false, code: 'conflict', message: 'You have already submitted a quote.' };
  }

  const rfq = await loadRfqOwner(db, orgId, rfqId);
  if (!rfq) return { ok: false, code: 'not_found', message: 'RFQ not found.' };
  if (rfq.status !== 'OPEN') {
    return { ok: false, code: 'conflict', message: 'This RFQ is no longer open for quotes.' };
  }

  const items = input.items.filter((it) => it.description.trim() !== '');
  if (items.length === 0) {
    return { ok: false, code: 'invalid', message: 'Add at least one line item.' };
  }
  const priced = items.map((it) => ({
    ...it,
    amountMinor: Math.round(it.qty * it.unitRateMinor),
  }));
  const totalMinor = priced.reduce((sum, it) => sum + it.amountMinor, 0);

  const year = new Date().getUTCFullYear();
  const seq = (await countQuoteForYear(db, orgId, year)) + 1;
  const quoteNo = `QT-${year}-${String(seq).padStart(4, '0')}`;
  const quoteId = newId();
  const now = new Date().toISOString();

  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO quotes
              (id, org_id, rfq_id, contractor_id, quote_no, diagnosis, proposed_solution,
               total_minor, currency, site_visit_done, status, submitted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'KES', ?, 'SUBMITTED', ?)`,
      args: [
        quoteId,
        orgId,
        rfqId,
        contractorId,
        quoteNo,
        input.diagnosis,
        input.proposedSolution,
        totalMinor,
        input.siteVisitDone ? 1 : 0,
        now,
      ],
    });
    for (const it of priced) {
      await tx.execute({
        sql: `INSERT INTO quote_items
                (id, org_id, quote_id, category_id, description, unit, qty, unit_rate_minor,
                 amount_minor, currency, is_spare)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'KES', ?)`,
        args: [
          newId(),
          orgId,
          quoteId,
          it.categoryId,
          it.description.trim(),
          it.unit,
          it.qty,
          it.unitRateMinor,
          it.amountMinor,
          it.isSpare ? 1 : 0,
        ],
      });
    }
    const moved = await tx.execute({
      sql: `UPDATE rfq_invitations SET status = 'QUOTED'
             WHERE org_id = ? AND rfq_id = ? AND contractor_id = ? AND status IN ('INVITED','VIEWED')`,
      args: [orgId, rfqId, contractorId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This invitation can no longer be quoted.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'quotes.submit', 'quote', ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        quoteId,
        JSON.stringify({
          quote_no: quoteNo,
          rfq_id: rfqId,
          total_minor: totalMinor,
          items: priced.length,
        }),
      ],
    });
    await enqueue(tx, orgId, {
      recipientType: 'user',
      recipientId: rfq.createdBy,
      templateKey: 'quotes.submitted',
      subject: `New quote on ${rfq.rfqNo}`,
      body: `A contractor submitted quote ${quoteNo} on ${rfq.rfqNo}.`,
      entityType: 'rfq',
      entityId: rfqId,
    });
    await tx.commit();
    return { ok: true, quoteId, quoteNo };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'conflict', message: 'You have already submitted a quote.' };
    }
    throw err;
  }
}

export async function declineInvitation(
  db: Client,
  ctx: { orgId: string; userId: string },
  rfqId: string,
  reason: string,
): Promise<QuoteActionResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };

  const invRes = await db.execute({
    sql: `SELECT status FROM rfq_invitations
           WHERE org_id = ? AND rfq_id = ? AND contractor_id = ? LIMIT 1`,
    args: [orgId, rfqId, contractorId],
  });
  const invitation = invRes.rows[0];
  if (!invitation)
    return { ok: false, code: 'forbidden', message: 'You are not invited to this RFQ.' };
  if (String(invitation.status) === 'QUOTED') {
    return { ok: false, code: 'conflict', message: 'You have already submitted a quote.' };
  }

  const rfq = await loadRfqOwner(db, orgId, rfqId);
  if (!rfq) return { ok: false, code: 'not_found', message: 'RFQ not found.' };

  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE rfq_invitations SET status = 'DECLINED'
             WHERE org_id = ? AND rfq_id = ? AND contractor_id = ? AND status IN ('INVITED','VIEWED')`,
      args: [orgId, rfqId, contractorId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This invitation can no longer be declined.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'quotes.decline', 'rfq', ?, ?)`,
      args: [orgId, ctx.userId, rfqId, JSON.stringify({ reason: reason || null })],
    });
    await enqueue(tx, orgId, {
      recipientType: 'user',
      recipientId: rfq.createdBy,
      templateKey: 'quotes.declined',
      subject: `A contractor declined ${rfq.rfqNo}`,
      body: `A contractor declined the invitation to quote on ${rfq.rfqNo}.`,
      entityType: 'rfq',
      entityId: rfqId,
    });
    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Engineer marks a preferred quote without awarding. Any previously preferred
 * quote returns to SUBMITTED, so exactly one is SELECTED. The RFQ stays OPEN.
 */
export async function selectPreferredQuote(
  db: Client,
  ctx: { orgId: string; userId: string },
  rfqId: string,
  quoteId: string,
): Promise<QuoteActionResult> {
  const { orgId } = ctx;
  const rfq = await loadRfqOwner(db, orgId, rfqId);
  if (!rfq) return { ok: false, code: 'not_found', message: 'RFQ not found.' };
  if (rfq.status !== 'OPEN') {
    return { ok: false, code: 'conflict', message: 'Only an open RFQ can have a preferred quote.' };
  }

  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `UPDATE quotes SET status = 'SUBMITTED', updated_at = ?
             WHERE org_id = ? AND rfq_id = ? AND status = 'SELECTED'`,
      args: [now, orgId, rfqId],
    });
    const picked = await tx.execute({
      sql: `UPDATE quotes SET status = 'SELECTED', updated_at = ?
             WHERE id = ? AND org_id = ? AND rfq_id = ? AND status IN ('SUBMITTED','SELECTED')`,
      args: [now, quoteId, orgId, rfqId],
    });
    if (picked.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'invalid', message: 'Choose a submitted quote to prefer.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'quotes.select', 'quote', ?, ?)`,
      args: [orgId, ctx.userId, quoteId, JSON.stringify({ rfq_id: rfqId })],
    });
    await tx.commit();
    return { ok: true, quoteId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/** Move an invitation from INVITED to VIEWED when the contractor opens it. */
export async function markInvitationViewed(
  db: Client,
  orgId: string,
  contractorId: string,
  rfqId: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE rfq_invitations SET status = 'VIEWED'
           WHERE org_id = ? AND rfq_id = ? AND contractor_id = ? AND status = 'INVITED'`,
    args: [orgId, rfqId, contractorId],
  });
}

export interface ContractorRfqView {
  id: string;
  rfqNo: string;
  status: string;
  dueDate: string | null;
  currency: string;
  requestNo: string;
  issue: string;
  natureOfBreakdown: string | null;
  stationName: string;
  invitationStatus: string;
}

/** The RFQ as an invited contractor sees it, or null when not invited. */
export async function getRfqForContractor(
  db: Client,
  orgId: string,
  rfqId: string,
  contractorId: string,
): Promise<ContractorRfqView | null> {
  const res = await db.execute({
    sql: `SELECT rq.id, rq.rfq_no, rq.status, rq.due_date, rq.currency,
                 sr.request_no, sr.issue, sr.nature_of_breakdown, s.name AS station_name,
                 i.status AS invitation_status
            FROM rfq_invitations i
            JOIN rfqs rq ON rq.id = i.rfq_id
            JOIN service_requests sr ON sr.id = rq.request_id
            JOIN stations s ON s.id = sr.station_id
           WHERE i.org_id = ? AND i.rfq_id = ? AND i.contractor_id = ? LIMIT 1`,
    args: [orgId, rfqId, contractorId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    rfqNo: String(row.rfq_no),
    status: String(row.status),
    dueDate: row.due_date == null ? null : String(row.due_date),
    currency: String(row.currency),
    requestNo: String(row.request_no),
    issue: String(row.issue),
    natureOfBreakdown: row.nature_of_breakdown == null ? null : String(row.nature_of_breakdown),
    stationName: String(row.station_name),
    invitationStatus: String(row.invitation_status),
  };
}

export interface ContractorQuoteItem {
  description: string;
  unit: string | null;
  qty: number;
  unitRateMinor: number;
  amountMinor: number;
  currency: string;
  isSpare: boolean;
}

export interface ContractorQuote {
  id: string;
  quoteNo: string | null;
  diagnosis: string | null;
  proposedSolution: string | null;
  totalMinor: number;
  currency: string;
  siteVisitDone: boolean;
  status: string;
  submittedAt: string | null;
  items: ContractorQuoteItem[];
}

/** The contractor's own quote on this RFQ, with items, or null. */
export async function getQuoteForContractor(
  db: Client,
  orgId: string,
  rfqId: string,
  contractorId: string,
): Promise<ContractorQuote | null> {
  const res = await db.execute({
    sql: `SELECT id, quote_no, diagnosis, proposed_solution, total_minor, currency,
                 site_visit_done, status, submitted_at
            FROM quotes
           WHERE org_id = ? AND rfq_id = ? AND contractor_id = ? LIMIT 1`,
    args: [orgId, rfqId, contractorId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const quoteId = String(row.id);
  const itemRes = await db.execute({
    sql: `SELECT description, unit, qty, unit_rate_minor, amount_minor, currency, is_spare
            FROM quote_items WHERE org_id = ? AND quote_id = ? ORDER BY created_at`,
    args: [orgId, quoteId],
  });
  return {
    id: quoteId,
    quoteNo: row.quote_no == null ? null : String(row.quote_no),
    diagnosis: row.diagnosis == null ? null : String(row.diagnosis),
    proposedSolution: row.proposed_solution == null ? null : String(row.proposed_solution),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    siteVisitDone: Number(row.site_visit_done) === 1,
    status: String(row.status),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    items: itemRes.rows.map((it) => ({
      description: String(it.description),
      unit: it.unit == null ? null : String(it.unit),
      qty: Number(it.qty),
      unitRateMinor: Number(it.unit_rate_minor),
      amountMinor: Number(it.amount_minor),
      currency: String(it.currency),
      isSpare: Number(it.is_spare) === 1,
    })),
  };
}
