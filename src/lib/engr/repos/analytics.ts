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
  /** Raw key (status, priority or record id) the view turns into a drill link. */
  key?: string;
  /** Drill-through target the view attaches, so a segment or row is a real link. */
  href?: string;
}

export interface DashboardCharts {
  workOrdersByStatus: ChartDatum[];
  requestsByMonth: ChartDatum[];
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Bucket {
  key: string; // stable key: month 'YYYY-MM' or week-start 'YYYY-MM-DD'
  label: string; // human axis label: 'Jul' or '7 Jul'
  start: string; // inclusive 'YYYY-MM-DD'
  end: string; // exclusive 'YYYY-MM-DD'
}

// The last n calendar months, ending at (and including) the current month, each
// with its inclusive start and exclusive end, so the trend always reaches the
// present and empty months still appear as a zero point.
function recentMonths(n: number): Bucket[] {
  const now = new Date();
  const out: Bucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    out.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: MONTHS[d.getUTCMonth()],
      start: d.toISOString().slice(0, 10),
      end: next.toISOString().slice(0, 10),
    });
  }
  return out;
}

// The n weeks from the current week forward, each Monday-anchored, so the
// forward-looking maintenance view has a fixed, zero-filled set of columns.
function comingWeeks(n: number): Bucket[] {
  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow),
  );
  const out: Bucket[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Date(
      Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7 * i),
    );
    const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 7));
    const start = s.toISOString().slice(0, 10);
    out.push({
      key: start,
      label: `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}`,
      start,
      end: e.toISOString().slice(0, 10),
    });
  }
  return out;
}

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
  return order.map((o) => ({ label: o.label, value: byStatus.get(o.status) ?? 0, key: o.status }));
}

export async function getDashboardCharts(db: Client, orgId: string): Promise<DashboardCharts> {
  const months = recentMonths(6);
  const weeks = comingWeeks(8);
  const results = await db.batch(
    [
      {
        sql: `SELECT status, COUNT(*) AS n FROM work_orders
                WHERE org_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY n DESC`,
        args: [orgId],
      },
      {
        sql: `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS n FROM service_requests
                WHERE org_id = ? AND deleted_at IS NULL AND created_at >= ?
             GROUP BY ym`,
        args: [orgId, `${months[0].start}T00:00:00Z`],
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
               WHERE org_id = ? AND due_date >= ? AND due_date < ?
            GROUP BY wk`,
        args: [orgId, weeks[0].start, weeks[weeks.length - 1].end],
      },
      {
        sql: `SELECT wc.contractor_id AS id, c.name AS name, SUM(wc.total_minor) AS total FROM work_costs wc
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
        sql: `SELECT wo.station_id AS id, s.name AS name, COUNT(*) AS n FROM work_orders wo
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
      key: String(r.status),
    })),
    requestsByMonth: (() => {
      const byMonth = new Map(results[1].rows.map((r) => [String(r.ym), num(r.n)]));
      return months.map((m) => ({
        label: m.label,
        value: byMonth.get(m.key) ?? 0,
        key: m.key,
        href: `/requests?scope=all&from=${m.start}&to=${m.end}`,
      }));
    })(),
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
    pmByWeek: (() => {
      const byWeek = new Map(
        results[4].rows.map((r) => [String(r.wk), { n: num(r.n), notified: num(r.notified) }]),
      );
      return weeks.map((w) => {
        const hit = byWeek.get(w.key);
        const total = hit?.n ?? 0;
        return {
          label: w.label,
          value: total,
          display: total > 0 ? `${total} (${hit?.notified ?? 0} notified)` : '0',
          key: w.key,
          href: `/pm/calendar?from=${w.start}&to=${w.end}`,
        };
      });
    })(),
    spendByContractorMinor: results[5].rows.map((r) => ({
      label: String(r.name),
      value: num(r.total),
      key: String(r.id),
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
    openWorkByStation: results[7].rows.map((r) => ({
      label: String(r.name),
      value: num(r.n),
      key: String(r.id),
    })),
  };
}
