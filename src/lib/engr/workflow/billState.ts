/**
 * Billing ladder: the only writer of bills.status.
 *
 * Three approval levels (engineer, engineering manager, financial controller),
 * each guarded with optimistic concurrency and the segregation-of-duties rules.
 * A cost may sit on only one bill: the bill_costs primary key stops a repeat on
 * the same bill, and a guard here refuses a cost already on another non-rejected
 * bill. Only APPROVED work costs may be billed. Money is integer minor units;
 * the subtotal is the sum of attached cost amounts and the tax comes from org
 * settings. The PAID and reopen transitions are here too, driven by payments.
 */
import type { Client } from '@libsql/client/web';
import { enqueue, type SqlExecutor } from '../notify';
import { contractorForUser } from '../repos/techniciansPick';
import { usersWithPermission } from '../repos/approvers';
import { checkApprover } from './sod';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type BillResult =
  | { ok: true; billId?: string; billNo?: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid' | 'conflict'; message: string };

const LEVEL_STATUS: Record<number, string> = {
  1: 'PENDING_L1_ENG',
  2: 'PENDING_L2_ENG_MGR',
  3: 'PENDING_L3_FC',
};
const LEVEL_KEY: Record<number, string> = {
  1: 'bill.approve.l1',
  2: 'bill.approve.l2',
  3: 'bill.approve.l3',
};

async function vatBps(db: SqlExecutor, orgId: string): Promise<number> {
  const res = await db.execute({
    sql: `SELECT value_json FROM org_settings WHERE org_id = ? AND key = 'vat_rate_bps' LIMIT 1`,
    args: [orgId],
  });
  const raw = res.rows[0]?.value_json;
  if (typeof raw !== 'string') return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0)
      return Math.round(parsed);
  } catch {
    // Malformed: treat as no VAT.
  }
  return 0;
}

async function recomputeTotals(
  tx: SqlExecutor,
  orgId: string,
  billId: string,
  now: string,
): Promise<void> {
  const sub = await tx.execute({
    sql: `SELECT COALESCE(SUM(amount_minor), 0) AS subtotal FROM bill_costs WHERE bill_id = ? AND org_id = ?`,
    args: [billId, orgId],
  });
  const subtotal = Number(sub.rows[0]?.subtotal ?? 0);
  const bps = await vatBps(tx, orgId);
  const tax = Math.round((subtotal * bps) / 10000);
  await tx.execute({
    sql: `UPDATE bills SET subtotal_minor = ?, tax_minor = ?, total_minor = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
    args: [subtotal, tax, subtotal + tax, now, billId, orgId],
  });
}

interface BillCore {
  id: string;
  contractorId: string;
  status: string;
  currentLevel: number;
  totalMinor: number;
}

async function loadBill(db: SqlExecutor, orgId: string, billId: string): Promise<BillCore | null> {
  const res = await db.execute({
    sql: `SELECT id, contractor_id, status, current_level, total_minor FROM bills WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [billId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    contractorId: String(row.contractor_id),
    status: String(row.status),
    currentLevel: Number(row.current_level),
    totalMinor: Number(row.total_minor),
  };
}

async function billSubmitter(
  db: SqlExecutor,
  orgId: string,
  billId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT actor_user_id FROM audit_logs
           WHERE org_id = ? AND entity_type = 'bill' AND entity_id = ? AND action = 'bill.submit'
        ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, billId],
  });
  const row = res.rows[0];
  return row && row.actor_user_id != null ? String(row.actor_user_id) : null;
}

async function priorBillApprovers(
  db: SqlExecutor,
  orgId: string,
  billId: string,
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT approver_id FROM bill_approvals
           WHERE org_id = ? AND bill_id = ? AND decision = 'APPROVED' AND approver_id IS NOT NULL`,
    args: [orgId, billId],
  });
  return res.rows.map((r) => String(r.approver_id));
}

async function countBillForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM bills WHERE org_id = ? AND bill_no LIKE ?`,
    args: [orgId, `BILL-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

export async function createBill(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: { periodLabel: string | null; periodStart: string | null; periodEnd: string | null },
): Promise<BillResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };

  const year = new Date().getUTCFullYear();
  const base = await countBillForYear(db, orgId, year);
  for (let attempt = 0; attempt < 5; attempt++) {
    const billNo = `BILL-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const id = newId();
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `INSERT INTO bills (id, org_id, contractor_id, bill_no, period_label, period_start, period_end, status, current_level)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0)`,
        args: [
          id,
          orgId,
          contractorId,
          billNo,
          input.periodLabel,
          input.periodStart,
          input.periodEnd,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'bill.create', 'bill', ?, ?)`,
        args: [orgId, ctx.userId, id, JSON.stringify({ bill_no: billNo })],
      });
      await tx.commit();
      return { ok: true, billId: id, billNo };
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'Could not allocate a bill number.' };
}

export async function attachCost(
  db: Client,
  ctx: { orgId: string; userId: string },
  billId: string,
  costId: string,
): Promise<BillResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };
  const bill = await loadBill(db, orgId, billId);
  if (!bill) return { ok: false, code: 'not_found', message: 'Bill not found.' };
  if (bill.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This bill is not yours.' };
  }
  if (bill.status !== 'DRAFT') {
    return {
      ok: false,
      code: 'conflict',
      message: 'Costs can only be attached while the bill is a draft.',
    };
  }

  const costRes = await db.execute({
    sql: `SELECT total_minor, contractor_id, status FROM work_costs WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [costId, orgId],
  });
  const cost = costRes.rows[0];
  if (!cost) return { ok: false, code: 'not_found', message: 'Cost not found.' };
  if (String(cost.status) !== 'APPROVED') {
    return { ok: false, code: 'invalid', message: 'Only an approved cost can be billed.' };
  }
  if (String(cost.contractor_id) !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'That cost belongs to another contractor.' };
  }

  // One bill per cost: refuse a cost already on another non-rejected bill.
  const onOther = await db.execute({
    sql: `SELECT 1 FROM bill_costs bc JOIN bills b ON b.id = bc.bill_id
           WHERE bc.org_id = ? AND bc.cost_id = ? AND bc.bill_id != ? AND b.status != 'REJECTED' LIMIT 1`,
    args: [orgId, costId, billId],
  });
  if (onOther.rows[0]) {
    return { ok: false, code: 'conflict', message: 'That cost is already on another bill.' };
  }

  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO bill_costs (bill_id, cost_id, org_id, amount_minor) VALUES (?, ?, ?, ?)`,
      args: [billId, costId, orgId, Number(cost.total_minor)],
    });
    await recomputeTotals(tx, orgId, billId, now);
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'bill.attach', 'bill', ?, ?)`,
      args: [orgId, ctx.userId, billId, JSON.stringify({ cost_id: costId })],
    });
    await tx.commit();
    return { ok: true, billId };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'conflict', message: 'That cost is already on this bill.' };
    }
    throw err;
  }
}

export async function submitBill(
  db: Client,
  ctx: { orgId: string; userId: string },
  billId: string,
): Promise<BillResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };
  const bill = await loadBill(db, orgId, billId);
  if (!bill) return { ok: false, code: 'not_found', message: 'Bill not found.' };
  if (bill.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This bill is not yours.' };
  }
  const count = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM bill_costs WHERE bill_id = ? AND org_id = ?`,
    args: [billId, orgId],
  });
  if (Number(count.rows[0]?.n ?? 0) === 0) {
    return {
      ok: false,
      code: 'invalid',
      message: 'Attach at least one approved cost before submitting.',
    };
  }
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE bills SET status = 'PENDING_L1_ENG', current_level = 1, submitted_at = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'DRAFT'`,
      args: [now, now, billId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This bill can no longer be submitted.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'bill.submit', 'bill', ?, ?)`,
      args: [orgId, ctx.userId, billId, JSON.stringify({ status: 'PENDING_L1_ENG' })],
    });
    const l1 = await usersWithPermission(tx, orgId, LEVEL_KEY[1]);
    for (const userId of l1) {
      await enqueue(tx, orgId, {
        recipientType: 'user',
        recipientId: userId,
        templateKey: 'bill.pending.l1',
        subject: 'A bill needs level 1 approval',
        body: 'A contractor submitted a bill for approval.',
        entityType: 'bill',
        entityId: billId,
      });
    }
    await tx.commit();
    return { ok: true, billId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function decideBill(
  db: Client,
  ctx: { orgId: string; userId: string },
  billId: string,
  level: 1 | 2 | 3,
  decision: 'approve' | 'reject',
  comment: string,
): Promise<BillResult> {
  const { orgId } = ctx;
  const bill = await loadBill(db, orgId, billId);
  if (!bill) return { ok: false, code: 'not_found', message: 'Bill not found.' };
  const expected = LEVEL_STATUS[level];
  if (bill.status !== expected || bill.currentLevel !== level) {
    return { ok: false, code: 'conflict', message: 'This bill is not awaiting that level.' };
  }

  const submitter = await billSubmitter(db, orgId, billId);
  const priors = await priorBillApprovers(db, orgId, billId);
  const sod = checkApprover({
    actorId: ctx.userId,
    submitterId: submitter,
    priorApproverIds: priors,
  });
  if (!sod.ok)
    return { ok: false, code: 'forbidden', message: sod.reason ?? 'Segregation of duties.' };

  const now = new Date().toISOString();
  const approve = decision === 'approve';
  let nextStatus: string;
  let nextLevel: number;
  if (!approve) {
    nextStatus = 'REJECTED';
    nextLevel = bill.currentLevel;
  } else if (level === 1) {
    nextStatus = 'PENDING_L2_ENG_MGR';
    nextLevel = 2;
  } else if (level === 2) {
    nextStatus = 'PENDING_L3_FC';
    nextLevel = 3;
  } else {
    nextStatus = 'APPROVED_READY_FOR_PAYMENT';
    nextLevel = 3;
  }

  const tx = await db.transaction('write');
  try {
    const stampApproved = approve && level === 3;
    const moved = await tx.execute({
      sql: `UPDATE bills SET status = ?, current_level = ?, ${stampApproved ? 'approved_at = ?, ' : ''}updated_at = ?
             WHERE id = ? AND org_id = ? AND status = ? AND current_level = ?`,
      args: stampApproved
        ? [nextStatus, nextLevel, now, now, billId, orgId, expected, level]
        : [nextStatus, nextLevel, now, billId, orgId, expected, level],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'This bill changed before the decision completed.',
      };
    }
    await tx.execute({
      sql: `INSERT INTO bill_approvals (id, org_id, bill_id, level, approver_id, decision, comment, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        orgId,
        billId,
        level,
        ctx.userId,
        approve ? 'APPROVED' : 'REJECTED',
        comment || null,
        now,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'bill.decision', 'bill', ?, ?)`,
      args: [orgId, ctx.userId, billId, JSON.stringify({ level, decision, status: nextStatus })],
    });

    if (approve && level < 3) {
      const next = await usersWithPermission(tx, orgId, LEVEL_KEY[level + 1]);
      for (const userId of next) {
        await enqueue(tx, orgId, {
          recipientType: 'user',
          recipientId: userId,
          templateKey: `bill.pending.l${level + 1}`,
          subject: `A bill needs level ${level + 1} approval`,
          body: `A bill passed level ${level} and needs the next approval.`,
          entityType: 'bill',
          entityId: billId,
        });
      }
    } else {
      await enqueue(tx, orgId, {
        recipientType: 'contractor',
        recipientId: bill.contractorId,
        templateKey: approve ? 'bill.approved' : 'bill.rejected',
        subject: approve ? 'Your bill is ready for payment' : 'Your bill was not approved',
        body: approve
          ? 'Your bill was fully approved and is ready for payment.'
          : `Your bill was rejected. ${comment || ''}`.trim(),
        entityType: 'bill',
        entityId: billId,
      });
    }
    await tx.commit();
    return { ok: true, billId };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        code: 'conflict',
        message: 'A decision was already recorded at this level.',
      };
    }
    throw err;
  }
}

/** Sum of non-reversed payments against a bill. */
async function paidTotal(db: SqlExecutor, orgId: string, billId: string): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM payments
           WHERE org_id = ? AND bill_id = ? AND status != 'REVERSED'`,
    args: [orgId, billId],
  });
  return Number(res.rows[0]?.paid ?? 0);
}

/** Move a ready bill to PAID once payments cover the total. Driven by payments. */
export async function markPaidIfCovered(
  db: Client,
  ctx: { orgId: string; userId: string },
  billId: string,
): Promise<void> {
  const bill = await loadBill(db, ctx.orgId, billId);
  if (!bill || bill.status !== 'APPROVED_READY_FOR_PAYMENT') return;
  const paid = await paidTotal(db, ctx.orgId, billId);
  if (paid < bill.totalMinor) return;
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE bills SET status = 'PAID', updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'APPROVED_READY_FOR_PAYMENT'`,
      args: [now, billId, ctx.orgId],
    });
    if (moved.rowsAffected === 1) {
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'bill.paid', 'bill', ?, ?)`,
        args: [ctx.orgId, ctx.userId, billId, JSON.stringify({ status: 'PAID' })],
      });
      await enqueue(tx, ctx.orgId, {
        recipientType: 'contractor',
        recipientId: bill.contractorId,
        templateKey: 'bill.paid',
        subject: 'Your bill has been paid',
        body: 'Your bill has been settled in full.',
        entityType: 'bill',
        entityId: billId,
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/** Reopen a PAID bill when payments no longer cover it. Driven by a reversal. */
export async function reopenIfUncovered(
  db: Client,
  ctx: { orgId: string; userId: string },
  billId: string,
): Promise<void> {
  const bill = await loadBill(db, ctx.orgId, billId);
  if (!bill || bill.status !== 'PAID') return;
  const paid = await paidTotal(db, ctx.orgId, billId);
  if (paid >= bill.totalMinor) return;
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE bills SET status = 'APPROVED_READY_FOR_PAYMENT', updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'PAID'`,
      args: [now, billId, ctx.orgId],
    });
    if (moved.rowsAffected === 1) {
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'bill.reopen', 'bill', ?, ?)`,
        args: [
          ctx.orgId,
          ctx.userId,
          billId,
          JSON.stringify({ status: 'APPROVED_READY_FOR_PAYMENT' }),
        ],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
