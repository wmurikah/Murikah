/**
 * Payments against a ready bill. Recording and reversing write the payment row's
 * status; the bill's own status is only ever changed through billState
 * (markPaidIfCovered and reopenIfUncovered). Partial settlement is supported: a
 * bill becomes PAID only once non-reversed payments cover the total, and a
 * reversal reopens it if the paid total drops below the total. Org-scoped.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { markPaidIfCovered, reopenIfUncovered } from '../workflow/billState';
import { checkPayer } from '../workflow/sod';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export type PaymentResult =
  | { ok: true; paymentId?: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid' | 'conflict'; message: string };

async function l3Approver(db: Client, orgId: string, billId: string): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT approver_id FROM bill_approvals
           WHERE org_id = ? AND bill_id = ? AND level = 3 AND decision = 'APPROVED' AND approver_id IS NOT NULL LIMIT 1`,
    args: [orgId, billId],
  });
  const row = res.rows[0];
  return row ? String(row.approver_id) : null;
}

export async function recordPayment(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: {
    billId: string;
    amountMinor: number;
    method: string | null;
    reference: string | null;
    paidAt: string | null;
  },
): Promise<PaymentResult> {
  const { orgId } = ctx;
  const billRes = await db.execute({
    sql: `SELECT contractor_id, status, total_minor FROM bills WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [input.billId, orgId],
  });
  const bill = billRes.rows[0];
  if (!bill) return { ok: false, code: 'not_found', message: 'Bill not found.' };
  if (String(bill.status) !== 'APPROVED_READY_FOR_PAYMENT') {
    return { ok: false, code: 'conflict', message: 'This bill is not ready for payment.' };
  }

  // Segregation of duties: the approver-versus-payer switch.
  const payerCheck = checkPayer({
    actorId: ctx.userId,
    l3ApproverId: await l3Approver(db, orgId, input.billId),
  });
  if (!payerCheck.ok)
    return { ok: false, code: 'forbidden', message: payerCheck.reason ?? 'Segregation of duties.' };

  const paidRes = await db.execute({
    sql: `SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM payments
           WHERE org_id = ? AND bill_id = ? AND status != 'REVERSED'`,
    args: [orgId, input.billId],
  });
  const remaining = Number(bill.total_minor) - Number(paidRes.rows[0]?.paid ?? 0);
  if (!(input.amountMinor > 0)) {
    return { ok: false, code: 'invalid', message: 'Enter a positive amount.' };
  }
  if (input.amountMinor > remaining) {
    return { ok: false, code: 'invalid', message: 'The amount exceeds the outstanding balance.' };
  }

  const id = newId();
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO payments (id, org_id, bill_id, amount_minor, method, reference, paid_at, recorded_by, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECORDED')`,
      args: [
        id,
        orgId,
        input.billId,
        input.amountMinor,
        input.method,
        input.reference,
        input.paidAt ?? now,
        ctx.userId,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'payment.record', 'payment', ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        id,
        JSON.stringify({ bill_id: input.billId, amount_minor: input.amountMinor }),
      ],
    });
    await enqueue(tx, orgId, {
      recipientType: 'contractor',
      recipientId: String(bill.contractor_id),
      templateKey: 'payment.recorded',
      subject: 'A payment was recorded on your bill',
      body: 'A payment has been recorded against your bill.',
      entityType: 'bill',
      entityId: input.billId,
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  // The bill's status is owned by billState.
  await markPaidIfCovered(db, ctx, input.billId);
  return { ok: true, paymentId: id };
}

export async function reversePayment(
  db: Client,
  ctx: { orgId: string; userId: string },
  paymentId: string,
): Promise<PaymentResult> {
  const { orgId } = ctx;
  const payRes = await db.execute({
    sql: `SELECT bill_id, status FROM payments WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [paymentId, orgId],
  });
  const pay = payRes.rows[0];
  if (!pay) return { ok: false, code: 'not_found', message: 'Payment not found.' };
  if (String(pay.status) === 'REVERSED') {
    return { ok: false, code: 'conflict', message: 'This payment is already reversed.' };
  }
  const billId = String(pay.bill_id);
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE payments SET status = 'REVERSED' WHERE id = ? AND org_id = ? AND status != 'REVERSED'`,
      args: [paymentId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This payment can no longer be reversed.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'payment.reverse', 'payment', ?, ?)`,
      args: [orgId, ctx.userId, paymentId, JSON.stringify({ bill_id: billId })],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  await reopenIfUncovered(db, ctx, billId);
  return { ok: true, paymentId };
}

// ---- reads ------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  amountMinor: number;
  currency: string;
  method: string | null;
  reference: string | null;
  paidAt: string | null;
  status: string;
}

export async function listPaymentsForBill(
  db: Client,
  orgId: string,
  billId: string,
): Promise<PaymentRow[]> {
  const res = await db.execute({
    sql: `SELECT id, amount_minor, currency, method, reference, paid_at, status
            FROM payments WHERE org_id = ? AND bill_id = ? ORDER BY created_at`,
    args: [orgId, billId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    method: row.method == null ? null : String(row.method),
    reference: row.reference == null ? null : String(row.reference),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    status: String(row.status),
  }));
}

export interface ReadyBillRow {
  id: string;
  billNo: string;
  contractorName: string;
  totalMinor: number;
  paidMinor: number;
  currency: string;
}

/** Bills ready for payment, with how much has been paid so far. */
export async function listReadyBills(db: Client, orgId: string): Promise<ReadyBillRow[]> {
  const res = await db.execute({
    sql: `SELECT b.id, b.bill_no, b.total_minor, b.currency, c.name AS contractor_name,
                 (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p
                   WHERE p.bill_id = b.id AND p.org_id = b.org_id AND p.status != 'REVERSED') AS paid
            FROM bills b
            JOIN contractors c ON c.id = b.contractor_id
           WHERE b.org_id = ? AND b.status = 'APPROVED_READY_FOR_PAYMENT'
        ORDER BY b.created_at`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    billNo: String(row.bill_no),
    contractorName: String(row.contractor_name),
    totalMinor: Number(row.total_minor),
    paidMinor: Number(row.paid ?? 0),
    currency: String(row.currency),
  }));
}

export interface RecentPaymentRow {
  id: string;
  billId: string;
  billNo: string;
  amountMinor: number;
  currency: string;
  method: string | null;
  status: string;
  paidAt: string | null;
}

/** Recent payments across the org, so the financial controller can reverse one. */
export async function listRecentPayments(
  db: Client,
  orgId: string,
  limit = 50,
): Promise<RecentPaymentRow[]> {
  const res = await db.execute({
    sql: `SELECT p.id, p.bill_id, p.amount_minor, p.currency, p.method, p.status, p.paid_at, b.bill_no
            FROM payments p
            JOIN bills b ON b.id = p.bill_id AND b.org_id = p.org_id
           WHERE p.org_id = ? ORDER BY p.created_at DESC LIMIT ?`,
    args: [orgId, limit],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    billId: String(row.bill_id),
    billNo: String(row.bill_no),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    method: row.method == null ? null : String(row.method),
    status: String(row.status),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
  }));
}
