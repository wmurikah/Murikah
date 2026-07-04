/**
 * Dashboard queries: the four seeded views, each filtered by the current org.
 * Each card returns just a total count and a short-window delta, so the metric
 * cards stay compact: the label, the number, one delta line and one drill link.
 * The detail lives in the filtered destination list, one click away, so the
 * dashboard does not carry long inline record lists.
 *
 * The eight reads run in a single batch, so the shell renders from one round
 * trip.
 */
import type { Client } from '@libsql/client/web';

export interface CountCard {
  count: number;
  // Momentum for the number: how many arrived in the last seven days (for the
  // maintenance card, how many fall due in the next seven), so a glance gives a
  // direction, not just a magnitude.
  recent: number;
}

export interface Dashboard {
  openWorkOrders: CountCard;
  pendingCostApprovals: CountCard;
  pendingBillApprovals: CountCard;
  upcomingPm: CountCard;
}

export async function getDashboard(db: Client, orgId: string): Promise<Dashboard> {
  const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const weekAhead = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const results = await db.batch(
    [
      { sql: `SELECT COUNT(*) AS n FROM v_open_work_orders WHERE org_id = ?`, args: [orgId] },
      { sql: `SELECT COUNT(*) AS n FROM v_pending_cost_approvals WHERE org_id = ?`, args: [orgId] },
      { sql: `SELECT COUNT(*) AS n FROM v_pending_bill_approvals WHERE org_id = ?`, args: [orgId] },
      { sql: `SELECT COUNT(*) AS n FROM v_upcoming_pm WHERE org_id = ?`, args: [orgId] },
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
    openWorkOrders: { count: count(0), recent: count(4) },
    pendingCostApprovals: { count: count(1), recent: count(5) },
    pendingBillApprovals: { count: count(2), recent: count(6) },
    upcomingPm: { count: count(3), recent: count(7) },
  };
}
