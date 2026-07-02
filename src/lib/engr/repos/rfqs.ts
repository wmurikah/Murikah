/**
 * RFQ repository: raise an RFQ from an accepted request and invite pre-qualified
 * contractors, read an RFQ for the engineer comparison, and list RFQs by role.
 * Every query is scoped by org_id. The RFQ status is only moved by the award and
 * procurement paths in workflow/rfqAward.ts, never here.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { listEligibleContractors } from './contractorsPick';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export interface CreateRfqInput {
  requestId: string;
  dueDate: string | null;
  thresholdMinor: number | null;
  contractorIds: string[];
}

export type CreateRfqResult =
  | { ok: true; rfqId: string; rfqNo: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict'; message: string };

async function countRfqForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM rfqs WHERE org_id = ? AND rfq_no LIKE ?`,
    args: [orgId, `RFQ-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * The org's default procurement threshold in minor units, read from
 * org_settings (key procurement_threshold_minor). The stored value may be a bare
 * number or an object with a minor field. Returns null when unset.
 */
export async function defaultThresholdMinor(db: Client, orgId: string): Promise<number | null> {
  const res = await db.execute({
    sql: `SELECT value_json FROM org_settings
           WHERE org_id = ? AND key = 'procurement_threshold_minor' LIMIT 1`,
    args: [orgId],
  });
  const raw = res.rows[0]?.value_json;
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.round(parsed);
    if (parsed && typeof parsed === 'object' && 'minor' in parsed) {
      const minor = (parsed as { minor: unknown }).minor;
      if (typeof minor === 'number' && Number.isFinite(minor)) return Math.round(minor);
    }
  } catch {
    // Malformed setting: treat as unset.
  }
  return null;
}

export async function createRfqWithInvitations(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: CreateRfqInput,
): Promise<CreateRfqResult> {
  const { orgId } = ctx;

  const reqRes = await db.execute({
    sql: `SELECT station_id, category_id, status FROM service_requests
           WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [input.requestId, orgId],
  });
  const request = reqRes.rows[0];
  if (!request) return { ok: false, code: 'not_found', message: 'Request not found.' };
  if (String(request.status) !== 'ACCEPTED') {
    return { ok: false, code: 'conflict', message: 'Raise an RFQ from an accepted request.' };
  }
  const stationId = String(request.station_id);
  const categoryId = request.category_id == null ? null : String(request.category_id);

  // Only pre-qualified contractors covering the station or category may be invited.
  const eligible = await listEligibleContractors(db, orgId, stationId, categoryId);
  const eligibleIds = new Set(eligible.map((c) => c.id));
  const chosen = [...new Set(input.contractorIds)].filter((id) => eligibleIds.has(id));
  if (chosen.length === 0) {
    return { ok: false, code: 'invalid', message: 'Choose at least one eligible contractor.' };
  }

  const year = new Date().getUTCFullYear();
  const base = await countRfqForYear(db, orgId, year);

  for (let attempt = 0; attempt < 5; attempt++) {
    const rfqNo = `RFQ-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const rfqId = newId();
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `INSERT INTO rfqs
                (id, org_id, rfq_no, request_id, created_by, due_date, approval_threshold_minor,
                 currency, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'KES', 'OPEN')`,
        args: [
          rfqId,
          orgId,
          rfqNo,
          input.requestId,
          ctx.userId,
          input.dueDate,
          input.thresholdMinor,
        ],
      });
      for (const contractorId of chosen) {
        await tx.execute({
          sql: `INSERT INTO rfq_invitations (id, org_id, rfq_id, contractor_id, status)
                VALUES (?, ?, ?, ?, 'INVITED')`,
          args: [newId(), orgId, rfqId, contractorId],
        });
      }
      await tx.execute({
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'rfq.create', 'rfq', ?, ?)`,
        args: [
          orgId,
          ctx.userId,
          rfqId,
          JSON.stringify({
            rfq_no: rfqNo,
            request_id: input.requestId,
            invited: chosen.length,
            threshold_minor: input.thresholdMinor,
          }),
        ],
      });
      for (const contractorId of chosen) {
        await enqueue(tx, orgId, {
          recipientType: 'contractor',
          recipientId: contractorId,
          templateKey: 'rfq.invited',
          subject: `Invitation to quote, ${rfqNo}`,
          body: `You are invited to quote on ${rfqNo}. Please submit a priced quote or decline.`,
          entityType: 'rfq',
          entityId: rfqId,
        });
      }
      await tx.commit();
      return { ok: true, rfqId, rfqNo };
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'Could not allocate an RFQ number.' };
}

// ---- reads ------------------------------------------------------------------

export interface RfqListRow {
  id: string;
  rfqNo: string;
  status: string;
  dueDate: string | null;
  requestNo: string;
  stationName: string;
  invited: number;
  quoted: number;
  createdAt: string;
}

export async function listRfqsForEngineer(db: Client, orgId: string): Promise<RfqListRow[]> {
  const res = await db.execute({
    sql: `SELECT rq.id, rq.rfq_no, rq.status, rq.due_date, rq.created_at,
                 sr.request_no, s.name AS station_name,
                 (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = rq.id) AS invited,
                 (SELECT COUNT(*) FROM quotes q
                   WHERE q.rfq_id = rq.id AND q.status IN ('SUBMITTED','SELECTED')) AS quoted
            FROM rfqs rq
            JOIN service_requests sr ON sr.id = rq.request_id
            JOIN stations s ON s.id = sr.station_id
           WHERE rq.org_id = ?
        ORDER BY rq.created_at DESC LIMIT 200`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    rfqNo: String(row.rfq_no),
    status: String(row.status),
    dueDate: row.due_date == null ? null : String(row.due_date),
    requestNo: String(row.request_no),
    stationName: String(row.station_name),
    invited: Number(row.invited ?? 0),
    quoted: Number(row.quoted ?? 0),
    createdAt: String(row.created_at),
  }));
}

export interface ContractorRfqRow {
  id: string;
  rfqNo: string;
  status: string;
  dueDate: string | null;
  requestNo: string;
  stationName: string;
  invitationStatus: string;
  hasQuoted: boolean;
  createdAt: string;
}

export async function listRfqsForContractor(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<ContractorRfqRow[]> {
  const res = await db.execute({
    sql: `SELECT rq.id, rq.rfq_no, rq.status, rq.due_date, rq.created_at,
                 sr.request_no, s.name AS station_name,
                 i.status AS invitation_status,
                 (SELECT COUNT(*) FROM quotes q WHERE q.rfq_id = rq.id AND q.contractor_id = ?) AS mine
            FROM rfq_invitations i
            JOIN rfqs rq ON rq.id = i.rfq_id
            JOIN service_requests sr ON sr.id = rq.request_id
            JOIN stations s ON s.id = sr.station_id
           WHERE i.org_id = ? AND i.contractor_id = ?
        ORDER BY rq.created_at DESC LIMIT 200`,
    args: [contractorId, orgId, contractorId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    rfqNo: String(row.rfq_no),
    status: String(row.status),
    dueDate: row.due_date == null ? null : String(row.due_date),
    requestNo: String(row.request_no),
    stationName: String(row.station_name),
    invitationStatus: String(row.invitation_status),
    hasQuoted: Number(row.mine ?? 0) > 0,
    createdAt: String(row.created_at),
  }));
}

export interface RfqInvitationRow {
  contractorId: string;
  contractorName: string;
  status: string;
  invitedAt: string;
}

export interface RfqQuoteItem {
  id: string;
  description: string;
  unit: string | null;
  qty: number;
  unitRateMinor: number;
  amountMinor: number;
  currency: string;
  isSpare: boolean;
}

export interface RfqQuote {
  id: string;
  contractorId: string;
  contractorName: string;
  quoteNo: string | null;
  diagnosis: string | null;
  proposedSolution: string | null;
  totalMinor: number;
  currency: string;
  siteVisitDone: boolean;
  status: string;
  submittedAt: string | null;
  items: RfqQuoteItem[];
}

export interface RfqDetail {
  id: string;
  rfqNo: string;
  status: string;
  createdBy: string;
  dueDate: string | null;
  thresholdMinor: number | null;
  currency: string;
  requestId: string;
  requestNo: string;
  stationName: string;
  categoryName: string | null;
  invitations: RfqInvitationRow[];
  quotes: RfqQuote[];
}

export async function getRfqDetail(
  db: Client,
  orgId: string,
  rfqId: string,
): Promise<RfqDetail | null> {
  const head = await db.execute({
    sql: `SELECT rq.id, rq.rfq_no, rq.status, rq.created_by, rq.due_date,
                 rq.approval_threshold_minor, rq.currency, rq.request_id,
                 sr.request_no, s.name AS station_name, ac.name AS category_name
            FROM rfqs rq
            JOIN service_requests sr ON sr.id = rq.request_id
            JOIN stations s ON s.id = sr.station_id
            LEFT JOIN asset_categories ac ON ac.id = sr.category_id
           WHERE rq.id = ? AND rq.org_id = ? LIMIT 1`,
    args: [rfqId, orgId],
  });
  const row = head.rows[0];
  if (!row) return null;

  const invRes = await db.execute({
    sql: `SELECT i.contractor_id, c.name AS contractor_name, i.status, i.invited_at
            FROM rfq_invitations i
            JOIN contractors c ON c.id = i.contractor_id
           WHERE i.org_id = ? AND i.rfq_id = ?
        ORDER BY c.name`,
    args: [orgId, rfqId],
  });
  const quoteRes = await db.execute({
    sql: `SELECT q.id, q.contractor_id, c.name AS contractor_name, q.quote_no, q.diagnosis,
                 q.proposed_solution, q.total_minor, q.currency, q.site_visit_done, q.status,
                 q.submitted_at
            FROM quotes q
            JOIN contractors c ON c.id = q.contractor_id
           WHERE q.org_id = ? AND q.rfq_id = ?
        ORDER BY q.total_minor ASC`,
    args: [orgId, rfqId],
  });
  const itemRes = await db.execute({
    sql: `SELECT qi.id, qi.quote_id, qi.description, qi.unit, qi.qty, qi.unit_rate_minor,
                 qi.amount_minor, qi.currency, qi.is_spare
            FROM quote_items qi
            JOIN quotes q ON q.id = qi.quote_id
           WHERE qi.org_id = ? AND q.rfq_id = ?
        ORDER BY qi.created_at`,
    args: [orgId, rfqId],
  });

  const itemsByQuote = new Map<string, RfqQuoteItem[]>();
  for (const it of itemRes.rows) {
    const quoteId = String(it.quote_id);
    const list = itemsByQuote.get(quoteId) ?? [];
    list.push({
      id: String(it.id),
      description: String(it.description),
      unit: it.unit == null ? null : String(it.unit),
      qty: Number(it.qty),
      unitRateMinor: Number(it.unit_rate_minor),
      amountMinor: Number(it.amount_minor),
      currency: String(it.currency),
      isSpare: Number(it.is_spare) === 1,
    });
    itemsByQuote.set(quoteId, list);
  }

  return {
    id: String(row.id),
    rfqNo: String(row.rfq_no),
    status: String(row.status),
    createdBy: String(row.created_by),
    dueDate: row.due_date == null ? null : String(row.due_date),
    thresholdMinor:
      row.approval_threshold_minor == null ? null : Number(row.approval_threshold_minor),
    currency: String(row.currency),
    requestId: String(row.request_id),
    requestNo: String(row.request_no),
    stationName: String(row.station_name),
    categoryName: row.category_name == null ? null : String(row.category_name),
    invitations: invRes.rows.map((i) => ({
      contractorId: String(i.contractor_id),
      contractorName: String(i.contractor_name),
      status: String(i.status),
      invitedAt: String(i.invited_at),
    })),
    quotes: quoteRes.rows.map((q) => ({
      id: String(q.id),
      contractorId: String(q.contractor_id),
      contractorName: String(q.contractor_name),
      quoteNo: q.quote_no == null ? null : String(q.quote_no),
      diagnosis: q.diagnosis == null ? null : String(q.diagnosis),
      proposedSolution: q.proposed_solution == null ? null : String(q.proposed_solution),
      totalMinor: Number(q.total_minor),
      currency: String(q.currency),
      siteVisitDone: Number(q.site_visit_done) === 1,
      status: String(q.status),
      submittedAt: q.submitted_at == null ? null : String(q.submitted_at),
      items: itemsByQuote.get(String(q.id)) ?? [],
    })),
  };
}

export interface PendingProcurementRow {
  id: string;
  rfqNo: string;
  requestNo: string;
  stationName: string;
  createdBy: string;
  thresholdMinor: number | null;
  currency: string;
  selectedContractorName: string | null;
  selectedTotalMinor: number | null;
}

/** RFQs awaiting procurement sign-off, with the selected quote shown. */
export async function listPendingProcurement(
  db: Client,
  orgId: string,
): Promise<PendingProcurementRow[]> {
  const res = await db.execute({
    sql: `SELECT rq.id, rq.rfq_no, rq.created_by, rq.approval_threshold_minor, rq.currency,
                 sr.request_no, s.name AS station_name,
                 q.total_minor AS selected_total, c.name AS selected_contractor
            FROM rfqs rq
            JOIN service_requests sr ON sr.id = rq.request_id
            JOIN stations s ON s.id = sr.station_id
            LEFT JOIN quotes q ON q.rfq_id = rq.id AND q.org_id = rq.org_id AND q.status = 'SELECTED'
            LEFT JOIN contractors c ON c.id = q.contractor_id
           WHERE rq.org_id = ? AND rq.status = 'SENT_TO_PROCUREMENT'
        ORDER BY rq.updated_at DESC LIMIT 200`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    rfqNo: String(row.rfq_no),
    requestNo: String(row.request_no),
    stationName: String(row.station_name),
    createdBy: String(row.created_by),
    thresholdMinor:
      row.approval_threshold_minor == null ? null : Number(row.approval_threshold_minor),
    currency: String(row.currency),
    selectedContractorName:
      row.selected_contractor == null ? null : String(row.selected_contractor),
    selectedTotalMinor: row.selected_total == null ? null : Number(row.selected_total),
  }));
}

/** The work order created from this RFQ's award, if any, for a detail link. */
export async function getAwardedWorkOrder(
  db: Client,
  orgId: string,
  rfqId: string,
): Promise<{ id: string; woNo: string } | null> {
  const res = await db.execute({
    sql: `SELECT wo.id, wo.wo_no
            FROM work_orders wo
            JOIN quotes q ON q.id = wo.quote_id
           WHERE wo.org_id = ? AND q.rfq_id = ? AND wo.deleted_at IS NULL
        ORDER BY wo.created_at DESC LIMIT 1`,
    args: [orgId, rfqId],
  });
  const row = res.rows[0];
  return row ? { id: String(row.id), woNo: String(row.wo_no) } : null;
}
