/**
 * Dashboard analytics. Every query is scoped to the one organisation. Counts are
 * returned raw; money is returned in integer minor units and formatted only at
 * the view layer. Each dataset is a small list of { label, value } so the view
 * can render an accessible bar chart with a data table.
 */
import type { Client } from '@libsql/client/web';

export interface ChartDatum {
  label: string;
  value: number;
  /** Optional pre-formatted value (money), else the view shows the number. */
  display?: string;
}

export interface DashboardCharts {
  workOrdersByStatus: ChartDatum[];
  requestsByWeek: ChartDatum[];
  costPipeline: ChartDatum[];
  billPipeline: ChartDatum[];
  pmByWeek: ChartDatum[];
  spendByContractorMinor: ChartDatum[];
  requestsByPriority: ChartDatum[];
  openWorkByStation: ChartDatum[];
}

// Monday-of-week for an ISO or date column, so rows bucket by week.
const weekBucket = (col: string) =>
  `date(${col}, '-' || ((strftime('%w', ${col}) + 6) % 7) || ' days')`;

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

// Build a datum list in a fixed order from a status → count lookup, so a stage
// with no rows still shows as an empty bar rather than vanishing.
function ordered(
  rows: { status: string; n: number }[],
  order: { status: string; label: string }[],
): ChartDatum[] {
  const byStatus = new Map(rows.map((r) => [r.status, r.n]));
  return order.map((o) => ({ label: o.label, value: byStatus.get(o.status) ?? 0 }));
}

export async function getDashboardCharts(db: Client, orgId: string): Promise<DashboardCharts> {
  const results = await db.batch(
    [
      {
        sql: `SELECT status, COUNT(*) AS n FROM work_orders
                WHERE org_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY n DESC`,
        args: [orgId],
      },
      {
        sql: `SELECT ${weekBucket('created_at')} AS wk, COUNT(*) AS n FROM service_requests
                WHERE org_id = ? AND deleted_at IS NULL
                  AND created_at >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-77 days')
             GROUP BY wk ORDER BY wk`,
        args: [orgId],
      },
      {
        sql: `SELECT status, COUNT(*) AS n FROM work_costs WHERE org_id = ? GROUP BY status`,
        args: [orgId],
      },
      {
        sql: `SELECT status, COUNT(*) AS n FROM bills WHERE org_id = ? GROUP BY status`,
        args: [orgId],
      },
      {
        sql: `SELECT ${weekBucket('due_date')} AS wk, COUNT(*) AS n,
                     SUM(CASE WHEN notified_1m_at IS NOT NULL OR notified_2w_at IS NOT NULL THEN 1 ELSE 0 END) AS notified
                FROM pm_occurrences
               WHERE org_id = ? AND due_date >= date('now') AND due_date < date('now', '+56 days')
            GROUP BY wk ORDER BY wk`,
        args: [orgId],
      },
      {
        sql: `SELECT c.name AS name, SUM(wc.total_minor) AS total FROM work_costs wc
                JOIN contractors c ON c.id = wc.contractor_id
               WHERE wc.org_id = ? AND wc.status = 'APPROVED'
            GROUP BY wc.contractor_id ORDER BY total DESC LIMIT 10`,
        args: [orgId],
      },
      {
        sql: `SELECT priority, COUNT(*) AS n FROM service_requests
                WHERE org_id = ? AND deleted_at IS NULL GROUP BY priority`,
        args: [orgId],
      },
      {
        sql: `SELECT s.name AS name, COUNT(*) AS n FROM work_orders wo
                JOIN stations s ON s.id = wo.station_id
               WHERE wo.org_id = ? AND wo.deleted_at IS NULL
                 AND wo.status NOT IN ('CLOSED', 'CANCELLED')
            GROUP BY wo.station_id ORDER BY n DESC LIMIT 10`,
        args: [orgId],
      },
    ],
    'read',
  );

  const costRows = results[2].rows.map((r) => ({ status: String(r.status), n: num(r.n) }));
  const billRows = results[3].rows.map((r) => ({ status: String(r.status), n: num(r.n) }));

  return {
    workOrdersByStatus: results[0].rows.map((r) => ({
      label: humanise(String(r.status)),
      value: num(r.n),
    })),
    requestsByWeek: results[1].rows.map((r) => ({ label: String(r.wk), value: num(r.n) })),
    costPipeline: ordered(costRows, [
      { status: 'SUBMITTED', label: 'Submitted' },
      { status: 'PENDING_L1', label: 'Pending level 1' },
      { status: 'PENDING_L2', label: 'Pending level 2' },
      { status: 'APPROVED', label: 'Approved' },
    ]),
    billPipeline: ordered(billRows, [
      { status: 'PENDING_L1_ENG', label: 'Pending engineer' },
      { status: 'PENDING_L2_ENG_MGR', label: 'Pending manager' },
      { status: 'PENDING_L3_FC', label: 'Pending controller' },
      { status: 'APPROVED_READY_FOR_PAYMENT', label: 'Ready for payment' },
      { status: 'PAID', label: 'Paid' },
    ]),
    pmByWeek: results[4].rows.map((r) => {
      const total = num(r.n);
      const notified = num(r.notified);
      return { label: String(r.wk), value: total, display: `${total} (${notified} notified)` };
    }),
    spendByContractorMinor: results[5].rows.map((r) => ({
      label: String(r.name),
      value: num(r.total),
    })),
    requestsByPriority: ordered(
      results[6].rows.map((r) => ({ status: String(r.priority), n: num(r.n) })),
      [
        { status: 'CRITICAL', label: 'Critical' },
        { status: 'HIGH', label: 'High' },
        { status: 'MEDIUM', label: 'Medium' },
        { status: 'LOW', label: 'Low' },
      ],
    ),
    openWorkByStation: results[7].rows.map((r) => ({ label: String(r.name), value: num(r.n) })),
  };
}
