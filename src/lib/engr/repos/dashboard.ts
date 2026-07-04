/**
 * Dashboard queries: the four seeded views, each filtered by the current org.
 * Every card returns a total count and a short preview list. Money is returned
 * as integer minor units (KES cents); the view layer formats it, not here.
 *
 * The eight reads run in a single batch, so the shell renders from one round
 * trip.
 */
import type { Client } from '@libsql/client/web';

export interface CountCard<T> {
  count: number;
  // Momentum for the number: how many arrived in the last seven days (for the
  // maintenance card, how many fall due in the next seven), so a glance gives a
  // direction, not just a magnitude.
  recent: number;
  items: T[];
}

export interface OpenWorkOrder {
  woNo: string;
  stationName: string | null;
  status: string;
}

export interface PendingCostApproval {
  workOrderId: string;
  totalMinor: number;
  currency: string;
  status: string;
}

export interface PendingBillApproval {
  billNo: string;
  totalMinor: number;
  currency: string;
  status: string;
}

export interface UpcomingPm {
  scheduleName: string;
  dueDate: string | null;
  status: string;
}

export interface Dashboard {
  openWorkOrders: CountCard<OpenWorkOrder>;
  pendingCostApprovals: CountCard<PendingCostApproval>;
  pendingBillApprovals: CountCard<PendingBillApproval>;
  upcomingPm: CountCard<UpcomingPm>;
}

const PREVIEW = 5;

export async function getDashboard(db: Client, orgId: string): Promise<Dashboard> {
  const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const weekAhead = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const results = await db.batch(
    [
      { sql: `SELECT COUNT(*) AS n FROM v_open_work_orders WHERE org_id = ?`, args: [orgId] },
      {
        sql: `SELECT wo_no, station_name, status FROM v_open_work_orders
               WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`,
        args: [orgId, PREVIEW],
      },
      { sql: `SELECT COUNT(*) AS n FROM v_pending_cost_approvals WHERE org_id = ?`, args: [orgId] },
      {
        sql: `SELECT work_order_id, total_minor, currency, status FROM v_pending_cost_approvals
               WHERE org_id = ? ORDER BY submitted_at DESC LIMIT ?`,
        args: [orgId, PREVIEW],
      },
      { sql: `SELECT COUNT(*) AS n FROM v_pending_bill_approvals WHERE org_id = ?`, args: [orgId] },
      {
        sql: `SELECT bill_no, total_minor, currency, status FROM v_pending_bill_approvals
               WHERE org_id = ? ORDER BY submitted_at DESC LIMIT ?`,
        args: [orgId, PREVIEW],
      },
      { sql: `SELECT COUNT(*) AS n FROM v_upcoming_pm WHERE org_id = ?`, args: [orgId] },
      {
        sql: `SELECT schedule_name, due_date, status FROM v_upcoming_pm
               WHERE org_id = ? ORDER BY due_date ASC LIMIT ?`,
        args: [orgId, PREVIEW],
      },
      // Momentum: arrivals in the last seven days, and for PM, due in the next seven.
      {
        sql: `SELECT COUNT(*) AS n FROM v_open_work_orders WHERE org_id = ? AND created_at >= ?`,
        args: [orgId, weekAgo],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM v_pending_cost_approvals WHERE org_id = ? AND submitted_at >= ?`,
        args: [orgId, weekAgo],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM v_pending_bill_approvals WHERE org_id = ? AND submitted_at >= ?`,
        args: [orgId, weekAgo],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM v_upcoming_pm WHERE org_id = ? AND due_date <= ?`,
        args: [orgId, weekAhead],
      },
    ],
    'read',
  );

  const count = (index: number): number => Number(results[index].rows[0]?.n ?? 0);

  return {
    openWorkOrders: {
      count: count(0),
      recent: count(8),
      items: results[1].rows.map((row) => ({
        woNo: String(row.wo_no),
        stationName: row.station_name === null ? null : String(row.station_name),
        status: String(row.status),
      })),
    },
    pendingCostApprovals: {
      count: count(2),
      recent: count(9),
      items: results[3].rows.map((row) => ({
        workOrderId: String(row.work_order_id),
        totalMinor: Number(row.total_minor ?? 0),
        currency: String(row.currency),
        status: String(row.status),
      })),
    },
    pendingBillApprovals: {
      count: count(4),
      recent: count(10),
      items: results[5].rows.map((row) => ({
        billNo: String(row.bill_no),
        totalMinor: Number(row.total_minor ?? 0),
        currency: String(row.currency),
        status: String(row.status),
      })),
    },
    upcomingPm: {
      count: count(6),
      recent: count(11),
      items: results[7].rows.map((row) => ({
        scheduleName: String(row.schedule_name),
        dueDate: row.due_date === null ? null : String(row.due_date),
        status: String(row.status),
      })),
    },
  };
}
