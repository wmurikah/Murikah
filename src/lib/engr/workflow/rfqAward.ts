/**
 * RFQ award and procurement sign-off.
 *
 * This module owns work-order creation from a quote, the sibling of
 * createWorkOrderFromRequest in the repository layer. It is deliberately in the
 * workflow directory, next to the state machine, because it sets a work order's
 * initial status. It does not transition an existing work order and does not
 * duplicate the execution flow: it creates the work order at CONTRACTOR_ACCEPTED
 * and every later status change runs through applyTransition unchanged.
 *
 * Two paths:
 *  - awardRfq: the engineer awards a winning quote. At or below the RFQ's
 *    approval threshold the work order is created straight away. Above it, the
 *    RFQ moves to SENT_TO_PROCUREMENT and no work order is created yet.
 *  - decideProcurement: a second, eligible approver signs off (or rejects) an
 *    above-threshold award. Approval creates the work order.
 *
 * The RFQ status carries the optimistic-concurrency guard: the award UPDATE runs
 * WHERE status = 'OPEN' (or SENT_TO_PROCUREMENT for procurement), so a second
 * concurrent award is a clean conflict, never a double award. A quote is the
 * contractor's agreement to the work, so the work order starts at
 * CONTRACTOR_ACCEPTED with contractor_accepted_at stamped, one step ahead of the
 * predefined-rate path which starts at CONTRACTOR_NOTIFIED.
 */
import type { Client } from '@libsql/client/web';
import { enqueue, type SqlExecutor } from '../notify';
import { WO_STATUS } from './workOrderState';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

// Roles that may always sign off a procurement award, regardless of the
// segregation-of-duties rule. There is no dedicated procurement role in the seed
// yet; add 'PROCUREMENT' to this list when it is introduced.
const ALWAYS_APPROVE_ROLES = ['OWNER', 'ADMIN'];

export interface WorkflowActor {
  orgId: string;
  userId: string;
  perms: string[];
  roles: string[];
}

// The narrow result of creating a work order from a quote: it awards or it fails,
// never routes to procurement (that is sendToProcurement's job). Shared by both
// the direct award and procurement approval, so it must fit both outcome types.
export type AwardedOrError =
  | {
      ok: true;
      outcome: 'awarded';
      workOrderId: string;
      woNo: string;
      status: 'CONTRACTOR_ACCEPTED';
    }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict' | 'invalid'; message: string };

export type AwardOutcome =
  | AwardedOrError
  | { ok: true; outcome: 'sent_to_procurement'; status: 'SENT_TO_PROCUREMENT' };

export type ProcurementOutcome =
  | {
      ok: true;
      outcome: 'awarded';
      workOrderId: string;
      woNo: string;
      status: 'CONTRACTOR_ACCEPTED';
    }
  | { ok: true; outcome: 'reopened' | 'cancelled'; status: 'OPEN' | 'CANCELLED' }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict' | 'invalid'; message: string };

interface RfqCore {
  id: string;
  rfqNo: string;
  requestId: string;
  createdBy: string;
  thresholdMinor: number | null;
  currency: string;
  status: string;
}

interface QuoteCore {
  id: string;
  contractorId: string;
  totalMinor: number;
  status: string;
}

interface RequestSite {
  stationId: string;
  categoryId: string | null;
}

async function loadRfq(db: Client, orgId: string, rfqId: string): Promise<RfqCore | null> {
  const res = await db.execute({
    sql: `SELECT id, rfq_no, request_id, created_by, approval_threshold_minor, currency, status
            FROM rfqs WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [rfqId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    rfqNo: String(row.rfq_no),
    requestId: String(row.request_id),
    createdBy: String(row.created_by),
    thresholdMinor:
      row.approval_threshold_minor == null ? null : Number(row.approval_threshold_minor),
    currency: String(row.currency),
    status: String(row.status),
  };
}

async function loadQuote(
  db: Client,
  orgId: string,
  rfqId: string,
  quoteId: string,
): Promise<QuoteCore | null> {
  const res = await db.execute({
    sql: `SELECT id, contractor_id, total_minor, status
            FROM quotes WHERE id = ? AND org_id = ? AND rfq_id = ? LIMIT 1`,
    args: [quoteId, orgId, rfqId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    contractorId: String(row.contractor_id),
    totalMinor: Number(row.total_minor),
    status: String(row.status),
  };
}

async function loadSelectedQuote(
  db: Client,
  orgId: string,
  rfqId: string,
): Promise<QuoteCore | null> {
  const res = await db.execute({
    sql: `SELECT id, contractor_id, total_minor, status
            FROM quotes WHERE org_id = ? AND rfq_id = ? AND status = 'SELECTED' LIMIT 1`,
    args: [orgId, rfqId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    contractorId: String(row.contractor_id),
    totalMinor: Number(row.total_minor),
    status: String(row.status),
  };
}

async function loadRequestSite(
  db: Client,
  orgId: string,
  requestId: string,
): Promise<RequestSite | null> {
  const res = await db.execute({
    sql: `SELECT station_id, category_id FROM service_requests
           WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [requestId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    stationId: String(row.station_id),
    categoryId: row.category_id == null ? null : String(row.category_id),
  };
}

async function countWoForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM work_orders WHERE org_id = ? AND wo_no LIKE ?`,
    args: [orgId, `WO-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Create the work order from the winning quote, inside one transaction, moving
 * the RFQ from `fromStatus` to AWARDED under an optimistic guard. Used by both
 * the direct (below-threshold) award and procurement approval; `procurement`
 * only tags the audit trail. The wo_no is allocated with a retry on the unique
 * constraint, each attempt in a fresh transaction.
 */
async function createWorkOrderFromQuote(
  db: Client,
  actor: WorkflowActor,
  rfq: RfqCore,
  quote: QuoteCore,
  site: RequestSite,
  fromStatus: string,
  procurement: boolean,
): Promise<AwardedOrError> {
  const year = new Date().getUTCFullYear();
  const base = await countWoForYear(db, actor.orgId, year);
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const woNo = `WO-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const id = newId();
    const tx = await db.transaction('write');
    try {
      // Award the RFQ under an optimistic guard, so a second concurrent award
      // cannot proceed.
      const awarded = await tx.execute({
        sql: `UPDATE rfqs SET status = 'AWARDED', updated_at = ?
               WHERE id = ? AND org_id = ? AND status = ?`,
        args: [now, rfq.id, actor.orgId, fromStatus],
      });
      if (awarded.rowsAffected === 0) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'The RFQ is no longer awaitable.' };
      }

      // Winning quote SELECTED, the rest REJECTED.
      await tx.execute({
        sql: `UPDATE quotes SET status = 'SELECTED', updated_at = ?
               WHERE id = ? AND org_id = ? AND rfq_id = ?`,
        args: [now, quote.id, actor.orgId, rfq.id],
      });
      await tx.execute({
        sql: `UPDATE quotes SET status = 'REJECTED', updated_at = ?
               WHERE org_id = ? AND rfq_id = ? AND id != ? AND status IN ('DRAFT','SUBMITTED','SELECTED')`,
        args: [now, actor.orgId, rfq.id, quote.id],
      });

      // The linked request moves to ASSIGNED, the same value the predefined-rate
      // path sets. Guarded on ACCEPTED; if it has already moved the award still
      // stands, the RFQ guard above is the authoritative single-award lock.
      await tx.execute({
        sql: `UPDATE service_requests SET status = 'ASSIGNED', updated_at = ?
               WHERE id = ? AND org_id = ? AND status = 'ACCEPTED'`,
        args: [now, rfq.requestId, actor.orgId],
      });

      // Create the work order already accepted by the contractor.
      await tx.execute({
        sql: `INSERT INTO work_orders
                (id, org_id, wo_no, request_id, quote_id, station_id, category_id, contractor_id,
                 source, assignment_basis, status, created_by, contractor_accepted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RFQ', 'QUOTE', 'CONTRACTOR_ACCEPTED', ?, ?)`,
        args: [
          id,
          actor.orgId,
          woNo,
          rfq.requestId,
          quote.id,
          site.stationId,
          site.categoryId,
          quote.contractorId,
          actor.userId,
          now,
        ],
      });

      await tx.execute({
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'workorder.create', 'work_order', ?, ?)`,
        args: [
          actor.orgId,
          actor.userId,
          id,
          JSON.stringify({ wo_no: woNo, status: WO_STATUS.CONTRACTOR_ACCEPTED, source: 'RFQ' }),
        ],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'rfq.award', 'rfq', ?, ?)`,
        args: [
          actor.orgId,
          actor.userId,
          rfq.id,
          JSON.stringify({
            decision: 'awarded',
            procurement,
            quote_id: quote.id,
            wo_no: woNo,
            total_minor: quote.totalMinor,
            threshold_minor: rfq.thresholdMinor,
          }),
        ],
      });

      await enqueue(tx, actor.orgId, {
        recipientType: 'contractor',
        recipientId: quote.contractorId,
        templateKey: 'rfq.awarded',
        subject: `Quote accepted, work order ${woNo}`,
        body: `Your quote on ${rfq.rfqNo} was accepted. Work order ${woNo} is ready for you to assign a technician.`,
        entityType: 'work_order',
        entityId: id,
      });
      await enqueue(tx, actor.orgId, {
        recipientType: 'user',
        recipientId: rfq.createdBy,
        templateKey: 'rfq.awarded.owner',
        subject: `RFQ ${rfq.rfqNo} awarded`,
        body: `RFQ ${rfq.rfqNo} was awarded and work order ${woNo} created.`,
        entityType: 'rfq',
        entityId: rfq.id,
      });

      await tx.commit();
      return {
        ok: true,
        outcome: 'awarded',
        workOrderId: id,
        woNo,
        status: WO_STATUS.CONTRACTOR_ACCEPTED,
      };
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'Could not allocate a work order number.' };
}

async function notifyProcurementApprovers(
  tx: SqlExecutor,
  orgId: string,
  senderUserId: string,
  rfq: RfqCore,
): Promise<void> {
  // Notify the always-eligible approvers (OWNER, ADMIN), never the sender.
  const placeholders = ALWAYS_APPROVE_ROLES.map(() => '?').join(',');
  const res = await tx.execute({
    sql: `SELECT DISTINCT u.id AS id
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
           WHERE u.org_id = ? AND u.status = 'ACTIVE'
             AND (r.org_id IS NULL OR r.org_id = ?)
             AND r.code IN (${placeholders})
             AND u.id != ?`,
    args: [orgId, orgId, ...ALWAYS_APPROVE_ROLES, senderUserId],
  });
  for (const row of res.rows) {
    await enqueue(tx, orgId, {
      recipientType: 'user',
      recipientId: String(row.id),
      templateKey: 'rfq.procurement.pending',
      subject: `RFQ ${rfq.rfqNo} awaits procurement sign-off`,
      body: `RFQ ${rfq.rfqNo} has a selected quote above the approval threshold and needs a second approver.`,
      entityType: 'rfq',
      entityId: rfq.id,
    });
  }
}

async function sendToProcurement(
  db: Client,
  actor: WorkflowActor,
  rfq: RfqCore,
  quote: QuoteCore,
): Promise<AwardOutcome> {
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE rfqs SET status = 'SENT_TO_PROCUREMENT', updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'OPEN'`,
      args: [now, rfq.id, actor.orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'The RFQ is no longer open.' };
    }
    await tx.execute({
      sql: `UPDATE quotes SET status = 'SELECTED', updated_at = ?
             WHERE id = ? AND org_id = ? AND rfq_id = ?`,
      args: [now, quote.id, actor.orgId, rfq.id],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'rfq.award', 'rfq', ?, ?)`,
      args: [
        actor.orgId,
        actor.userId,
        rfq.id,
        JSON.stringify({
          decision: 'sent_to_procurement',
          quote_id: quote.id,
          total_minor: quote.totalMinor,
          threshold_minor: rfq.thresholdMinor,
        }),
      ],
    });
    await notifyProcurementApprovers(tx, actor.orgId, actor.userId, rfq);
    await tx.commit();
    return { ok: true, outcome: 'sent_to_procurement', status: 'SENT_TO_PROCUREMENT' };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Award a winning quote. Below or equal to the threshold the work order is
 * created; above it the RFQ is routed to procurement. Caller has already checked
 * the rfq.award permission.
 */
export async function awardRfq(
  db: Client,
  actor: WorkflowActor,
  rfqId: string,
  quoteId: string,
): Promise<AwardOutcome> {
  const rfq = await loadRfq(db, actor.orgId, rfqId);
  if (!rfq) return { ok: false, code: 'not_found', message: 'RFQ not found.' };
  if (rfq.status !== 'OPEN') {
    return { ok: false, code: 'conflict', message: 'Only an open RFQ can be awarded.' };
  }
  const quote = await loadQuote(db, actor.orgId, rfqId, quoteId);
  if (!quote) return { ok: false, code: 'invalid', message: 'Quote not found on this RFQ.' };
  if (quote.status !== 'SUBMITTED' && quote.status !== 'SELECTED') {
    return { ok: false, code: 'invalid', message: 'Only a submitted quote can be awarded.' };
  }
  const site = await loadRequestSite(db, actor.orgId, rfq.requestId);
  if (!site) return { ok: false, code: 'not_found', message: 'The linked request was not found.' };

  // A missing threshold is treated as needing sign-off, the conservative default.
  const belowThreshold = rfq.thresholdMinor != null && quote.totalMinor <= rfq.thresholdMinor;
  if (belowThreshold) {
    return createWorkOrderFromQuote(db, actor, rfq, quote, site, 'OPEN', false);
  }
  return sendToProcurement(db, actor, rfq, quote);
}

/** The user who sent this RFQ to procurement, read from the audit trail. */
async function procurementSender(db: Client, orgId: string, rfqId: string): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT actor_user_id FROM audit_logs
           WHERE org_id = ? AND entity_type = 'rfq' AND entity_id = ? AND action = 'rfq.award'
        ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, rfqId],
  });
  const row = res.rows[0];
  return row && row.actor_user_id != null ? String(row.actor_user_id) : null;
}

function isEligibleApprover(
  actor: WorkflowActor,
  rfq: RfqCore,
  senderUserId: string | null,
): boolean {
  if (!actor.perms.includes('rfq.award')) return false;
  if (actor.roles.some((role) => ALWAYS_APPROVE_ROLES.includes(role))) return true;
  return actor.userId !== rfq.createdBy && actor.userId !== senderUserId;
}

/**
 * Procurement sign-off on an above-threshold award. The approver must hold
 * rfq.award and, unless they are an OWNER or ADMIN, must not be the user who
 * raised the RFQ or sent it to procurement. Approval creates the work order;
 * rejection returns the RFQ to OPEN (freeing a fresh award) or CANCELLED.
 */
export async function decideProcurement(
  db: Client,
  actor: WorkflowActor,
  rfqId: string,
  decision: 'approve' | 'reject',
  options: { reason?: string; cancel?: boolean } = {},
): Promise<ProcurementOutcome> {
  const rfq = await loadRfq(db, actor.orgId, rfqId);
  if (!rfq) return { ok: false, code: 'not_found', message: 'RFQ not found.' };
  if (rfq.status !== 'SENT_TO_PROCUREMENT') {
    return { ok: false, code: 'conflict', message: 'This RFQ is not awaiting procurement.' };
  }

  const sender = await procurementSender(db, actor.orgId, rfqId);
  if (!isEligibleApprover(actor, rfq, sender)) {
    return {
      ok: false,
      code: 'forbidden',
      message: 'A different approver must sign off this award.',
    };
  }

  if (decision === 'approve') {
    const quote = await loadSelectedQuote(db, actor.orgId, rfqId);
    if (!quote) return { ok: false, code: 'invalid', message: 'No selected quote to approve.' };
    const site = await loadRequestSite(db, actor.orgId, rfq.requestId);
    if (!site)
      return { ok: false, code: 'not_found', message: 'The linked request was not found.' };
    return createWorkOrderFromQuote(db, actor, rfq, quote, site, 'SENT_TO_PROCUREMENT', true);
  }

  // Reject: return to OPEN for a fresh award, or CANCELLED, with the reason.
  const now = new Date().toISOString();
  const nextStatus: 'OPEN' | 'CANCELLED' = options.cancel ? 'CANCELLED' : 'OPEN';
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE rfqs SET status = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'SENT_TO_PROCUREMENT'`,
      args: [nextStatus, now, rfq.id, actor.orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This RFQ is not awaiting procurement.' };
    }
    if (nextStatus === 'OPEN') {
      // Free the selected quote so the RFQ can be re-awarded.
      await tx.execute({
        sql: `UPDATE quotes SET status = 'SUBMITTED', updated_at = ?
               WHERE org_id = ? AND rfq_id = ? AND status = 'SELECTED'`,
        args: [now, actor.orgId, rfq.id],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'rfq.award', 'rfq', ?, ?)`,
      args: [
        actor.orgId,
        actor.userId,
        rfq.id,
        JSON.stringify({
          decision: 'procurement_rejected',
          procurement: true,
          next_status: nextStatus,
          reason: options.reason ?? null,
        }),
      ],
    });
    await enqueue(tx, actor.orgId, {
      recipientType: 'user',
      recipientId: rfq.createdBy,
      templateKey: 'rfq.procurement.rejected',
      subject: `RFQ ${rfq.rfqNo} not approved`,
      body:
        nextStatus === 'OPEN'
          ? `Procurement did not approve RFQ ${rfq.rfqNo}. It is open again for a fresh award.`
          : `Procurement cancelled RFQ ${rfq.rfqNo}.`,
      entityType: 'rfq',
      entityId: rfq.id,
    });
    await tx.commit();
    return {
      ok: true,
      outcome: nextStatus === 'OPEN' ? 'reopened' : 'cancelled',
      status: nextStatus,
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
