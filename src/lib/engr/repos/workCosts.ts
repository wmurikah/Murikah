/**
 * Reads for the costing screens. Writes go through workflow/costState.ts. Every
 * query is org-scoped.
 */
import type { Client } from '@libsql/client/web';

export interface CostListRow {
  id: string;
  workOrderNo: string;
  contractorName: string;
  status: string;
  currentLevel: number;
  totalMinor: number;
  currency: string;
  createdAt: string;
}

const COST_LIST_SELECT = `
  SELECT wc.id, wc.status, wc.current_level, wc.total_minor, wc.currency, wc.created_at,
         wo.wo_no, c.name AS contractor_name
    FROM work_costs wc
    JOIN work_orders wo ON wo.id = wc.work_order_id
    JOIN contractors c ON c.id = wc.contractor_id
   WHERE wc.org_id = ?`;

function mapCostRow(row: Record<string, unknown>): CostListRow {
  return {
    id: String(row.id),
    workOrderNo: String(row.wo_no),
    contractorName: String(row.contractor_name),
    status: String(row.status),
    currentLevel: Number(row.current_level),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    createdAt: String(row.created_at),
  };
}

export async function listCostsForContractor(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<CostListRow[]> {
  const res = await db.execute({
    sql: `${COST_LIST_SELECT} AND wc.contractor_id = ? ORDER BY wc.created_at DESC LIMIT 200`,
    args: [orgId, contractorId],
  });
  return res.rows.map((r) => mapCostRow(r as Record<string, unknown>));
}

/** Costs awaiting a given approval level (1 or 2). */
export async function listPendingCosts(
  db: Client,
  orgId: string,
  level: 1 | 2,
): Promise<CostListRow[]> {
  const status = level === 1 ? 'PENDING_L1' : 'PENDING_L2';
  const res = await db.execute({
    sql: `${COST_LIST_SELECT} AND wc.status = ? ORDER BY wc.created_at LIMIT 200`,
    args: [orgId, status],
  });
  return res.rows.map((r) => mapCostRow(r as Record<string, unknown>));
}

/** Approved costs for a contractor not yet on a non-rejected bill, for billing. */
export async function listBillableCosts(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<CostListRow[]> {
  const res = await db.execute({
    sql: `${COST_LIST_SELECT} AND wc.contractor_id = ? AND wc.status = 'APPROVED'
             AND NOT EXISTS (
               SELECT 1 FROM bill_costs bc JOIN bills b ON b.id = bc.bill_id
                WHERE bc.cost_id = wc.id AND bc.org_id = wc.org_id AND b.status != 'REJECTED'
             )
        ORDER BY wc.created_at DESC LIMIT 200`,
    args: [orgId, contractorId],
  });
  return res.rows.map((r) => mapCostRow(r as Record<string, unknown>));
}

export interface CostItemRow {
  description: string;
  unit: string | null;
  qty: number;
  unitRateMinor: number;
  amountMinor: number;
  currency: string;
}

export interface CostApprovalRow {
  level: number;
  approverName: string | null;
  decision: string;
  comment: string | null;
  decidedAt: string | null;
}

export interface CostDetail {
  id: string;
  workOrderId: string;
  workOrderNo: string;
  contractorId: string;
  contractorName: string;
  costingBasis: string;
  status: string;
  currentLevel: number;
  recallable: boolean;
  subtotalMinor: number;
  mileageMinor: number;
  totalMinor: number;
  currency: string;
  items: CostItemRow[];
  approvals: CostApprovalRow[];
}

export async function getCostDetail(
  db: Client,
  orgId: string,
  costId: string,
): Promise<CostDetail | null> {
  const head = await db.execute({
    sql: `SELECT wc.id, wc.work_order_id, wc.contractor_id, wc.costing_basis, wc.status, wc.current_level,
                 wc.recallable, wc.subtotal_minor, wc.mileage_minor, wc.total_minor, wc.currency,
                 wo.wo_no, c.name AS contractor_name
            FROM work_costs wc
            JOIN work_orders wo ON wo.id = wc.work_order_id
            JOIN contractors c ON c.id = wc.contractor_id
           WHERE wc.id = ? AND wc.org_id = ? LIMIT 1`,
    args: [costId, orgId],
  });
  const row = head.rows[0];
  if (!row) return null;

  const itemsRes = await db.execute({
    sql: `SELECT description, unit, qty, unit_rate_minor, amount_minor, currency
            FROM work_cost_items WHERE org_id = ? AND cost_id = ? ORDER BY created_at`,
    args: [orgId, costId],
  });
  const apprRes = await db.execute({
    sql: `SELECT ca.level, ca.decision, ca.comment, ca.decided_at, u.full_name AS approver_name
            FROM cost_approvals ca
            LEFT JOIN users u ON u.id = ca.approver_id
           WHERE ca.org_id = ? AND ca.cost_id = ? ORDER BY ca.level`,
    args: [orgId, costId],
  });

  return {
    id: String(row.id),
    workOrderId: String(row.work_order_id),
    workOrderNo: String(row.wo_no),
    contractorId: String(row.contractor_id),
    contractorName: String(row.contractor_name),
    costingBasis: String(row.costing_basis),
    status: String(row.status),
    currentLevel: Number(row.current_level),
    recallable: Number(row.recallable) === 1,
    subtotalMinor: Number(row.subtotal_minor),
    mileageMinor: Number(row.mileage_minor),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    items: itemsRes.rows.map((it) => ({
      description: String(it.description),
      unit: it.unit == null ? null : String(it.unit),
      qty: Number(it.qty),
      unitRateMinor: Number(it.unit_rate_minor),
      amountMinor: Number(it.amount_minor),
      currency: String(it.currency),
    })),
    approvals: apprRes.rows.map((a) => ({
      level: Number(a.level),
      approverName: a.approver_name == null ? null : String(a.approver_name),
      decision: String(a.decision),
      comment: a.comment == null ? null : String(a.comment),
      decidedAt: a.decided_at == null ? null : String(a.decided_at),
    })),
  };
}

/** Closed work orders for a contractor that do not yet have a cost, for raising one. */
export async function listCostableWorkOrders(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<Array<{ id: string; woNo: string; stationName: string }>> {
  const res = await db.execute({
    sql: `SELECT wo.id, wo.wo_no, st.name AS station_name
            FROM work_orders wo
            JOIN stations st ON st.id = wo.station_id
           WHERE wo.org_id = ? AND wo.contractor_id = ? AND wo.status = 'CLOSED' AND wo.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM work_costs wc WHERE wc.work_order_id = wo.id AND wc.org_id = wo.org_id AND wc.status != 'REJECTED'
             )
        ORDER BY wo.created_at DESC LIMIT 100`,
    args: [orgId, contractorId],
  });
  return res.rows.map((w) => ({
    id: String(w.id),
    woNo: String(w.wo_no),
    stationName: String(w.station_name),
  }));
}
