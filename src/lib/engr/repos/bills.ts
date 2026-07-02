/**
 * Reads for the billing screens. Writes go through workflow/billState.ts. Every
 * query is org-scoped.
 */
import type { Client } from '@libsql/client/web';
import { listPaymentsForBill, type PaymentRow } from './payments';

const LEVEL_STATUS: Record<number, string> = {
  1: 'PENDING_L1_ENG',
  2: 'PENDING_L2_ENG_MGR',
  3: 'PENDING_L3_FC',
};

export interface BillListRow {
  id: string;
  billNo: string;
  contractorName: string;
  periodLabel: string | null;
  status: string;
  currentLevel: number;
  totalMinor: number;
  currency: string;
  createdAt: string;
}

const BILL_LIST_SELECT = `
  SELECT b.id, b.bill_no, b.period_label, b.status, b.current_level, b.total_minor, b.currency, b.created_at,
         c.name AS contractor_name
    FROM bills b
    JOIN contractors c ON c.id = b.contractor_id
   WHERE b.org_id = ?`;

function mapBillRow(row: Record<string, unknown>): BillListRow {
  return {
    id: String(row.id),
    billNo: String(row.bill_no),
    contractorName: String(row.contractor_name),
    periodLabel: row.period_label == null ? null : String(row.period_label),
    status: String(row.status),
    currentLevel: Number(row.current_level),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    createdAt: String(row.created_at),
  };
}

export async function listBillsForContractor(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<BillListRow[]> {
  const res = await db.execute({
    sql: `${BILL_LIST_SELECT} AND b.contractor_id = ? ORDER BY b.created_at DESC LIMIT 200`,
    args: [orgId, contractorId],
  });
  return res.rows.map((r) => mapBillRow(r as Record<string, unknown>));
}

export async function listPendingBills(
  db: Client,
  orgId: string,
  level: 1 | 2 | 3,
): Promise<BillListRow[]> {
  const res = await db.execute({
    sql: `${BILL_LIST_SELECT} AND b.status = ? ORDER BY b.created_at LIMIT 200`,
    args: [orgId, LEVEL_STATUS[level]],
  });
  return res.rows.map((r) => mapBillRow(r as Record<string, unknown>));
}

export interface BillCostRow {
  costId: string;
  workOrderNo: string;
  amountMinor: number;
  currency: string;
}

export interface BillApprovalRow {
  level: number;
  approverName: string | null;
  decision: string;
  comment: string | null;
  decidedAt: string | null;
}

export interface BillDetail {
  id: string;
  billNo: string;
  contractorId: string;
  contractorName: string;
  periodLabel: string | null;
  status: string;
  currentLevel: number;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  costs: BillCostRow[];
  approvals: BillApprovalRow[];
  payments: PaymentRow[];
  paidMinor: number;
}

export async function getBillDetail(
  db: Client,
  orgId: string,
  billId: string,
): Promise<BillDetail | null> {
  const head = await db.execute({
    sql: `SELECT b.id, b.bill_no, b.contractor_id, b.period_label, b.status, b.current_level,
                 b.subtotal_minor, b.tax_minor, b.total_minor, b.currency, c.name AS contractor_name
            FROM bills b
            JOIN contractors c ON c.id = b.contractor_id
           WHERE b.id = ? AND b.org_id = ? LIMIT 1`,
    args: [billId, orgId],
  });
  const row = head.rows[0];
  if (!row) return null;

  const costsRes = await db.execute({
    sql: `SELECT bc.cost_id, bc.amount_minor, wc.currency, wo.wo_no
            FROM bill_costs bc
            JOIN work_costs wc ON wc.id = bc.cost_id
            JOIN work_orders wo ON wo.id = wc.work_order_id
           WHERE bc.bill_id = ? AND bc.org_id = ? ORDER BY wo.wo_no`,
    args: [billId, orgId],
  });
  const apprRes = await db.execute({
    sql: `SELECT ba.level, ba.decision, ba.comment, ba.decided_at, u.full_name AS approver_name
            FROM bill_approvals ba
            LEFT JOIN users u ON u.id = ba.approver_id
           WHERE ba.org_id = ? AND ba.bill_id = ? ORDER BY ba.level`,
    args: [orgId, billId],
  });
  const payments = await listPaymentsForBill(db, orgId, billId);
  const paidMinor = payments
    .filter((p) => p.status !== 'REVERSED')
    .reduce((sum, p) => sum + p.amountMinor, 0);

  return {
    id: String(row.id),
    billNo: String(row.bill_no),
    contractorId: String(row.contractor_id),
    contractorName: String(row.contractor_name),
    periodLabel: row.period_label == null ? null : String(row.period_label),
    status: String(row.status),
    currentLevel: Number(row.current_level),
    subtotalMinor: Number(row.subtotal_minor),
    taxMinor: Number(row.tax_minor),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    costs: costsRes.rows.map((c) => ({
      costId: String(c.cost_id),
      workOrderNo: String(c.wo_no),
      amountMinor: Number(c.amount_minor),
      currency: String(c.currency),
    })),
    approvals: apprRes.rows.map((a) => ({
      level: Number(a.level),
      approverName: a.approver_name == null ? null : String(a.approver_name),
      decision: String(a.decision),
      comment: a.comment == null ? null : String(a.comment),
      decidedAt: a.decided_at == null ? null : String(a.decided_at),
    })),
    payments,
    paidMinor,
  };
}
