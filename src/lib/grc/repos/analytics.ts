/**
 * Portfolio analytics aggregation, ported from 09_AnalyticsService.gs. For the
 * acting organisation it summarises work papers (by status, by risk bucket and by
 * affiliate), action plans (total, overdue, implementation rate and by status) and
 * the six-month creation trends. Every query is scoped by organization_id. It also
 * builds a compact text summary for the AI insight prompt. Overdue and the risk
 * buckets reuse the reporting model so every surface agrees. Column names follow
 * grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';
import {
  RISK_BUCKETS,
  RISK_LABELS,
  normaliseRisk,
  humaniseStatus,
  NOT_OVERDUE_STATUSES,
  IMPLEMENTED_STATUSES,
  percent,
} from '@grc/reports/reportModel';

export interface NamedCount {
  label: string;
  value: number;
}
export interface TrendPoint {
  month: string;
  workPapers: number;
  actionPlans: number;
}
export interface Portfolio {
  workPapersTotal: number;
  wpByStatus: NamedCount[];
  wpByRisk: NamedCount[];
  wpByAffiliate: NamedCount[];
  apTotal: number;
  apOverdue: number;
  apImplemented: number;
  apImplementationRate: number;
  apByStatus: NamedCount[];
  trends: TrendPoint[];
}

const settled = NOT_OVERDUE_STATUSES.map(() => '?').join(', ');
const implemented = IMPLEMENTED_STATUSES.map(() => '?').join(', ');

function lastSixMonths(now: Date): string[] {
  const out: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export async function getPortfolio(
  db: Client,
  organizationId: string,
  labels: Map<string, string>,
  now: Date,
): Promise<Portfolio> {
  const [wpStatus, wpRisk, wpAff, apAgg, apStatus, wpTrend, apTrend] = await Promise.all([
    db.execute({
      sql: `SELECT status, COUNT(*) AS n FROM work_papers WHERE organization_id = ? GROUP BY status`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT risk_rating AS risk, COUNT(*) AS n FROM work_papers
             WHERE organization_id = ? GROUP BY risk_rating`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT COALESCE(aff.affiliate_name, 'Unassigned') AS affiliate, COUNT(*) AS n
              FROM work_papers wp
              LEFT JOIN affiliates aff ON aff.affiliate_code = wp.affiliate_code
                   AND aff.organization_id = wp.organization_id
             WHERE wp.organization_id = ?
          GROUP BY wp.affiliate_code ORDER BY n DESC LIMIT 10`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS total,
                   SUM(CASE WHEN due_date IS NOT NULL AND date(due_date) < date('now')
                             AND status NOT IN (${settled}) THEN 1 ELSE 0 END) AS overdue,
                   SUM(CASE WHEN status IN (${implemented}) THEN 1 ELSE 0 END) AS implemented
              FROM action_plans WHERE organization_id = ?`,
      args: [...NOT_OVERDUE_STATUSES, ...IMPLEMENTED_STATUSES, organizationId],
    }),
    db.execute({
      sql: `SELECT status, COUNT(*) AS n FROM action_plans WHERE organization_id = ? GROUP BY status`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT substr(created_at, 1, 7) AS m, COUNT(*) AS n FROM work_papers
             WHERE organization_id = ? AND created_at IS NOT NULL
               AND date(created_at) >= date('now', '-6 months') GROUP BY m`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT substr(created_at, 1, 7) AS m, COUNT(*) AS n FROM action_plans
             WHERE organization_id = ? AND created_at IS NOT NULL
               AND date(created_at) >= date('now', '-6 months') GROUP BY m`,
      args: [organizationId],
    }),
  ]);

  const wpByStatus: NamedCount[] = wpStatus.rows.map((r) => ({
    label: humaniseStatus(String(r.status), Object.fromEntries(labels)),
    value: Number(r.n ?? 0),
  }));
  const workPapersTotal = wpByStatus.reduce((s, x) => s + x.value, 0);

  const riskCounts = new Map<string, number>();
  for (const b of RISK_BUCKETS) riskCounts.set(b, 0);
  for (const r of wpRisk.rows) {
    const b = normaliseRisk(r.risk == null ? null : String(r.risk));
    if (b) riskCounts.set(b, (riskCounts.get(b) ?? 0) + Number(r.n ?? 0));
  }
  const wpByRisk: NamedCount[] = RISK_BUCKETS.map((b) => ({
    label: RISK_LABELS[b],
    value: riskCounts.get(b) ?? 0,
  }));

  const wpByAffiliate: NamedCount[] = wpAff.rows.map((r) => ({
    label: String(r.affiliate ?? 'Unassigned'),
    value: Number(r.n ?? 0),
  }));

  const agg = apAgg.rows[0] ?? {};
  const apTotal = Number(agg.total ?? 0);
  const apOverdue = Number(agg.overdue ?? 0);
  const apImplemented = Number(agg.implemented ?? 0);
  const apImplementationRate = percent(apImplemented, apTotal);
  const apByStatus: NamedCount[] = apStatus.rows.map((r) => ({
    label: humaniseStatus(String(r.status), Object.fromEntries(labels)),
    value: Number(r.n ?? 0),
  }));

  const wpMonth = new Map<string, number>();
  for (const r of wpTrend.rows) wpMonth.set(String(r.m), Number(r.n ?? 0));
  const apMonth = new Map<string, number>();
  for (const r of apTrend.rows) apMonth.set(String(r.m), Number(r.n ?? 0));
  const trends: TrendPoint[] = lastSixMonths(now).map((month) => ({
    month,
    workPapers: wpMonth.get(month) ?? 0,
    actionPlans: apMonth.get(month) ?? 0,
  }));

  return {
    workPapersTotal,
    wpByStatus,
    wpByRisk,
    wpByAffiliate,
    apTotal,
    apOverdue,
    apImplemented,
    apImplementationRate,
    apByStatus,
    trends,
  };
}

/** A compact text summary of the portfolio, for the AI analytics-insight prompt. */
export function portfolioSummary(p: Portfolio): string {
  const list = (rows: NamedCount[]): string =>
    rows.map((r) => `${r.label}: ${r.value}`).join(', ') || 'none';
  return [
    `Work papers: ${p.workPapersTotal}.`,
    `By status: ${list(p.wpByStatus)}.`,
    `By risk: ${list(p.wpByRisk)}.`,
    `By affiliate: ${list(p.wpByAffiliate)}.`,
    `Action plans: ${p.apTotal} total, ${p.apOverdue} overdue, implementation rate ${p.apImplementationRate}%.`,
    `Action plans by status: ${list(p.apByStatus)}.`,
    `Six-month trend (month, work papers, action plans): ${p.trends
      .map((t) => `${t.month} ${t.workPapers}/${t.actionPlans}`)
      .join('; ')}.`,
  ].join('\n');
}
