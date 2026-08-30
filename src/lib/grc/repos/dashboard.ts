/**
 * The dashboard and sidebar aggregation, ported from the source
 * 06_DashboardService.gs and getSidebarCounts. Everything is scoped by the acting
 * organization_id; the "my" and auditee views are additionally scoped to the
 * signed-in user. Counts and lists respect the same role scoping the sidebar uses
 * (GAP-510): a full-visibility role sees the organisation, an auditee sees their
 * own.
 *
 * Action plans have no audit area or affiliate of their own (GAP-507): to group
 * them by affiliate this joins through work_paper_id to work_papers.affiliate_code,
 * never a field on the action plan.
 *
 * Every column name comes from the typed schema layer (@grc/schema/columns), so a
 * name that is not on the live table fails `pnpm build` rather than the dashboard.
 *
 * The three expensive aggregations are cache-aside on a short window (Build
 * Prompt 42): they are the heaviest queries in the product and a count that is a
 * few seconds behind is not a count anyone acts on wrongly. Every work-paper and
 * action-plan mutation clears the organisation's dashboard namespace anyway, so
 * the window only ever matters between two edges.
 *
 * The scope is part of the key, not an afterthought. These reads are scoped by
 * role and by user as well as by organisation, so an entry computed for one
 * auditee must never be handed to another: scopeKey() carries exactly the inputs
 * that change the answer.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { CACHE_TTL, cacheKeys, cached } from '@grc/cache';
import { NOT_OVERDUE_STATUSES } from '@grc/reports/reportModel';
import { isAuditeeRole } from '@grc/dashboard/roleNav';
import {
  affiliatePredicate,
  affiliateScopeKey,
  type AffiliateScope,
  type ScopePredicate,
} from '@grc/auth/affiliateScope';

const WP = cols(C.work_papers);
const WPa = cols(C.work_papers, 'wp');
const AP = cols(C.action_plans);
const APa = cols(C.action_plans, 'ap');
const RESP = cols(C.work_paper_responsibles, 'r');
const AFF = cols(C.affiliates, 'aff');
const USR = cols(C.users, 'u');
const AA = cols(C.audit_areas, 'aa');
// The requirements loop, for the sidebar's "waiting on me" badge (Build Prompt 60).
const R = cols(C.work_paper_requirements, 'r');
const RO = cols(C.requirement_owners, 'o');
const RS = cols(C.requirement_submissions, 'sub');

// Seeded action-plan status literals the analytics buckets match. 'Not Implemented'
// is a seed value distinct from the workflow enum (AP_STATUS); 'Verified' and
// 'Closed' form the implemented bucket, and 'Not Due' the not-yet-due bucket, the
// same human-readable values stored on the row.
const NOT_IMPLEMENTED = 'Not Implemented';
const NOT_DUE = 'Not Due';

export interface DashboardScope {
  userId: string;
  roleCode: string;
  isPlatformOwner: boolean;
  perms: string[];
  /** The affiliate confinement in force, from locals.grc.affiliateScope. */
  affiliateScope: AffiliateScope;
}

/** An auditee (and not a platform owner) sees only their own items. */
function auditeeScoped(scope: DashboardScope): boolean {
  return isAuditeeRole(scope.roleCode) && !scope.isPlatformOwner;
}

/**
 * Everything beyond the organisation that changes the answer, as a key segment.
 * An auditee-scoped read counts only that user's items, so it is keyed to them;
 * every other role sees the same organisation-wide figures and shares one entry.
 */
function scopeKey(scope: DashboardScope): string {
  // The affiliate confinement is part of the key, not an afterthought: two
  // viewers with different confinement see genuinely different figures, and a
  // shared cache entry would hand one of them the other's totals. This is the
  // same reason an auditee-scoped read is keyed to its user.
  const base = auditeeScoped(scope) ? `user=${scope.userId}` : 'org';
  return `${base}:${affiliateScopeKey(scope.affiliateScope)}`;
}

/** The confinement predicate for a work-paper alias in this file's queries. */
function confineWp(scope: DashboardScope, alias = 'wp'): ScopePredicate {
  return affiliatePredicate(scope.affiliateScope, cols(C.work_papers, alias).affiliate_code);
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

// The overdue predicate on an action plan alias: past due and not settled.
const settledPlaceholders = NOT_OVERDUE_STATUSES.map(() => '?').join(', ');
function overdueClause(alias: string): string {
  const ap = cols(C.action_plans, alias);
  return `${ap.due_date} IS NOT NULL AND date(${ap.due_date}) < date('now') AND ${ap.status} NOT IN (${settledPlaceholders})`;
}
function ownerLike(userId: string): string {
  return `%,${userId},%`;
}

export interface StatCard {
  count: number;
  href: string;
}
export interface DashboardStats {
  workPapers: StatCard;
  pendingReview: StatCard;
  actionPlans: StatCard;
  overdue: StatCard;
}

/** The four stat cards, role-scoped. */
export async function getDashboardStats(
  db: Client,
  organizationId: string,
  scope: DashboardScope,
): Promise<DashboardStats> {
  return cached(
    db,
    cacheKeys.dashboard(organizationId, 'stats', scopeKey(scope)),
    CACHE_TTL.dashboard,
    () => readDashboardStats(db, organizationId, scope),
  );
}

async function readDashboardStats(
  db: Client,
  organizationId: string,
  scope: DashboardScope,
): Promise<DashboardStats> {
  const auditee = auditeeScoped(scope);
  const wpConfine = confineWp(scope);

  // Work papers and pending review.
  let workPapers = 0;
  let pendingReview = 0;
  if (auditee) {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS total FROM work_papers wp
             WHERE ${WPa.organization_id} = ?
               AND EXISTS (SELECT 1 FROM work_paper_responsibles r
                            WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}
                              AND ${RESP.user_id} = ?)${wpConfine.clause}`,
      args: [organizationId, scope.userId, ...wpConfine.args],
    });
    workPapers = num(res.rows[0]?.total);
    pendingReview = 0;
  } else {
    const bare = affiliatePredicate(scope.affiliateScope, WP.affiliate_code);
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS total,
                   SUM(CASE WHEN ${WP.status} = 'Submitted' THEN 1 ELSE 0 END) AS pending
              FROM work_papers WHERE ${WP.organization_id} = ?${bare.clause}`,
      args: [organizationId, ...bare.args],
    });
    workPapers = num(res.rows[0]?.total);
    pendingReview = num(res.rows[0]?.pending);
  }

  // Action plans and overdue.
  const apArgs: InArgs = [organizationId];
  let apWhere = `${AP.organization_id} = ?`;
  if (auditee) {
    apWhere += ` AND (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ?`;
    apArgs.push(ownerLike(scope.userId));
  }
  const apConfine = affiliatePredicate(scope.affiliateScope, AP.affiliate_code);
  apWhere += apConfine.clause;
  apArgs.push(...apConfine.args);
  const apRes = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN ${overdueClause('action_plans')} THEN 1 ELSE 0 END) AS overdue
            FROM action_plans WHERE ${apWhere}`,
    args: [...apArgs, ...NOT_OVERDUE_STATUSES],
  });

  return {
    workPapers: { count: workPapers, href: '/work-papers' },
    pendingReview: {
      count: pendingReview,
      href: '/work-papers?status=Submitted',
    },
    actionPlans: { count: num(apRes.rows[0]?.total), href: '/action-plans' },
    overdue: { count: num(apRes.rows[0]?.overdue), href: '/action-plans?overdue=1' },
  };
}

export interface ReviewItem {
  id: string;
  reference: string;
  title: string;
  risk: string | null;
  affiliate?: string | null;
  round?: number;
  href: string;
}
export interface PendingReviews {
  toReview: ReviewItem[];
  toVerify: ReviewItem[];
  responsesToReview: ReviewItem[];
}

/** The pending-reviews panel: work papers to review, action plans to verify, responses to review. */
export async function getPendingReviews(
  db: Client,
  organizationId: string,
  scope: DashboardScope,
): Promise<PendingReviews> {
  // Auditees do not have a review queue.
  if (auditeeScoped(scope)) return { toReview: [], toVerify: [], responsesToReview: [] };

  const wpBare = affiliatePredicate(scope.affiliateScope, WP.affiliate_code);
  const apBare = affiliatePredicate(scope.affiliateScope, AP.affiliate_code);
  const wpAliasBare = confineWp(scope);
  const [review, verify, responses] = await Promise.all([
    db.execute({
      sql: `SELECT ${WP.work_paper_id} AS id, ${WP.work_paper_ref} AS reference,
                   ${WP.observation_title} AS title, ${WP.risk_rating} AS risk
              FROM work_papers WHERE ${WP.organization_id} = ? AND ${WP.status} = 'Submitted'${wpBare.clause}
          ORDER BY ${WP.updated_at} DESC LIMIT 10`,
      args: [organizationId, ...wpBare.args],
    }),
    db.execute({
      sql: `SELECT ${AP.action_plan_id} AS id, COALESCE(${AP.action_ref}, ${AP.action_number}) AS reference,
                   ${AP.action_description} AS title
              FROM action_plans WHERE ${AP.organization_id} = ? AND ${AP.status} = 'Pending Verification'${apBare.clause}
          ORDER BY ${AP.updated_at} DESC LIMIT 10`,
      args: [organizationId, ...apBare.args],
    }),
    db.execute({
      sql: `SELECT ${WPa.work_paper_id} AS id, ${WPa.work_paper_ref} AS reference,
                   ${WPa.observation_title} AS title, ${WPa.risk_rating} AS risk,
                   ${AFF.affiliate_name} AS affiliate, ${WPa.revision_count} AS round
              FROM work_papers wp
              LEFT JOIN affiliates aff ON ${AFF.affiliate_code} = ${WPa.affiliate_code}
                   AND ${AFF.organization_id} = ${WPa.organization_id}
             WHERE ${WPa.organization_id} = ? AND ${WPa.status} = 'Response Received'${wpAliasBare.clause}
          ORDER BY ${WPa.updated_at} DESC LIMIT 10`,
      args: [organizationId, ...wpAliasBare.args],
    }),
  ]);

  const wp = (r: Record<string, unknown>): ReviewItem => ({
    id: String(r.id),
    reference: String(r.reference ?? r.id),
    title: String(r.title ?? ''),
    risk: s(r.risk),
    href: `/work-papers/${String(r.id)}`,
  });

  return {
    toReview: review.rows.map(wp),
    toVerify: verify.rows.map((r) => ({
      id: String(r.id),
      reference: String(r.reference ?? r.id),
      title: String(r.title ?? ''),
      risk: null,
      href: `/action-plans/${String(r.id)}`,
    })),
    responsesToReview: responses.rows.map((r) => ({
      ...wp(r),
      affiliate: s(r.affiliate),
      round: r.round == null ? undefined : num(r.round),
    })),
  };
}

export interface DueItem {
  id: string;
  reference: string;
  title: string;
  dueDate: string | null;
  owners: string | null;
  href: string;
}

/** Action plans due within seven days and not settled, scoped by role. */
export async function getDueThisWeek(
  db: Client,
  organizationId: string,
  scope: DashboardScope,
): Promise<DueItem[]> {
  const args: InArgs = [organizationId, ...NOT_OVERDUE_STATUSES];
  let where = `${AP.organization_id} = ? AND ${AP.due_date} IS NOT NULL
               AND date(${AP.due_date}) >= date('now') AND date(${AP.due_date}) <= date('now', '+7 days')
               AND ${AP.status} NOT IN (${settledPlaceholders})`;
  if (auditeeScoped(scope)) {
    where += ` AND (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ?`;
    args.push(ownerLike(scope.userId));
  }
  const dueConfine = affiliatePredicate(scope.affiliateScope, AP.affiliate_code);
  where += dueConfine.clause;
  args.push(...dueConfine.args);
  const res = await db.execute({
    sql: `SELECT ${AP.action_plan_id} AS id, COALESCE(${AP.action_ref}, ${AP.action_number}) AS reference,
                 ${AP.action_description} AS title, ${AP.due_date}, ${AP.owner_names} AS owners
            FROM action_plans WHERE ${where}
        ORDER BY ${AP.due_date} ASC LIMIT 12`,
    args,
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    reference: String(r.reference ?? r.id),
    title: String(r.title ?? ''),
    dueDate: s(r.due_date),
    owners: s(r.owners),
    href: `/action-plans/${String(r.id)}`,
  }));
}

export interface ActivityItem {
  type: 'work_paper' | 'action_plan';
  reference: string;
  title: string;
  status: string;
  updatedAt: string | null;
  href: string;
}

/** Recent work papers and action plans, mixed and newest first, scoped by role. */
export async function getRecentActivity(
  db: Client,
  organizationId: string,
  scope: DashboardScope,
): Promise<ActivityItem[]> {
  const auditee = auditeeScoped(scope);
  const wpArgs: InArgs = [organizationId];
  let wpWhere = `${WPa.organization_id} = ?`;
  if (auditee) {
    wpWhere +=
      ` AND EXISTS (SELECT 1 FROM work_paper_responsibles r WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}` +
      ` AND ${RESP.user_id} = ?)`;
    wpArgs.push(scope.userId);
  }
  const wpConfine = confineWp(scope);
  wpWhere += wpConfine.clause;
  wpArgs.push(...wpConfine.args);
  const apArgs: InArgs = [organizationId];
  let apWhere = `${AP.organization_id} = ?`;
  if (auditee) {
    apWhere += ` AND (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ?`;
    apArgs.push(ownerLike(scope.userId));
  }
  const apConfine = affiliatePredicate(scope.affiliateScope, AP.affiliate_code);
  apWhere += apConfine.clause;
  apArgs.push(...apConfine.args);

  const [wpRes, apRes] = await Promise.all([
    db.execute({
      sql: `SELECT ${WPa.work_paper_id} AS id, ${WPa.work_paper_ref} AS reference,
                   ${WPa.observation_title} AS title, ${WPa.status} AS status, ${WPa.updated_at} AS updated_at
              FROM work_papers wp WHERE ${wpWhere}
          ORDER BY ${WPa.updated_at} DESC LIMIT 12`,
      args: wpArgs,
    }),
    db.execute({
      sql: `SELECT ${AP.action_plan_id} AS id, COALESCE(${AP.action_ref}, ${AP.action_number}) AS reference,
                   ${AP.action_description} AS title, ${AP.status}, ${AP.updated_at}
              FROM action_plans WHERE ${apWhere}
          ORDER BY ${AP.updated_at} DESC LIMIT 12`,
      args: apArgs,
    }),
  ]);

  const items: ActivityItem[] = [
    ...wpRes.rows.map((r) => ({
      type: 'work_paper' as const,
      reference: String(r.reference ?? r.id),
      title: String(r.title ?? ''),
      status: String(r.status),
      updatedAt: s(r.updated_at),
      href: `/work-papers/${String(r.id)}`,
    })),
    ...apRes.rows.map((r) => ({
      type: 'action_plan' as const,
      reference: String(r.reference ?? r.id),
      title: String(r.title ?? ''),
      status: String(r.status),
      updatedAt: s(r.updated_at),
      href: `/action-plans/${String(r.id)}`,
    })),
  ];
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return items.slice(0, 12);
}

export interface ChartDatum {
  label: string;
  value: number;
  href?: string;
}
export interface AffiliateBar {
  label: string;
  open: number;
  closed: number;
}
export interface TeamPerformance {
  auditorProductivity: ChartDatum[];
  affiliateComparison: AffiliateBar[];
}

/** Team-performance charts: work papers per auditor, and open vs closed action plans per affiliate. */
export async function getTeamPerformance(
  db: Client,
  organizationId: string,
  scope: DashboardScope,
): Promise<TeamPerformance> {
  // Both halves aggregate through work_papers wp, so one predicate covers them.
  const confine = confineWp(scope);
  const [productivity, affiliates] = await Promise.all([
    db.execute({
      sql: `SELECT ${USR.full_name} AS auditor, COUNT(*) AS n
              FROM work_papers wp
              JOIN users u ON ${USR.user_id} = ${WPa.assigned_auditor_id}
             WHERE ${WPa.organization_id} = ? AND ${WPa.assigned_auditor_id} IS NOT NULL${confine.clause}
          GROUP BY ${WPa.assigned_auditor_id}
          ORDER BY n DESC LIMIT 10`,
      args: [organizationId, ...confine.args],
    }),
    // Action plans have no affiliate of their own: join through the work paper (GAP-507).
    db.execute({
      sql: `SELECT ${AFF.affiliate_name} AS affiliate,
                   SUM(CASE WHEN ${APa.status} IN (${settledPlaceholders}) THEN 1 ELSE 0 END) AS closed,
                   SUM(CASE WHEN ${APa.status} NOT IN (${settledPlaceholders}) THEN 1 ELSE 0 END) AS open
              FROM action_plans ap
              JOIN work_papers wp ON ${WPa.work_paper_id} = ${APa.work_paper_id}
                   AND ${WPa.organization_id} = ${APa.organization_id}
              LEFT JOIN affiliates aff ON ${AFF.affiliate_code} = ${WPa.affiliate_code}
                   AND ${AFF.organization_id} = ${WPa.organization_id}
             WHERE ${APa.organization_id} = ?${confine.clause}
          GROUP BY ${WPa.affiliate_code}
          ORDER BY (open + closed) DESC LIMIT 10`,
      args: [...NOT_OVERDUE_STATUSES, ...NOT_OVERDUE_STATUSES, organizationId, ...confine.args],
    }),
  ]);

  return {
    auditorProductivity: productivity.rows.map((r) => ({
      label: String(r.auditor ?? 'Unassigned'),
      value: num(r.n),
    })),
    affiliateComparison: affiliates.rows.map((r) => ({
      label: String(r.affiliate ?? 'Unassigned'),
      open: num(r.open),
      closed: num(r.closed),
    })),
  };
}

// ---- Dashboard analytics charts --------------------------------------------
// Four org-scoped, year-filterable aggregations behind the dashboard charts.
// Areas come from audit_areas; an action plan carries no area of its own, so it
// joins through work_paper_id to the work paper and on to its audit area
// (GAP-507). Every column name is from the typed schema layer, so a rename fails
// the build rather than a chart.

/** A multi-series grouped bar: named series (each a colour tone) and per-area rows. */
export interface BarSeries {
  label: string;
  /** Semantic tone the view maps to a colour token (risk or status meaning). */
  tone: string;
}
export interface GroupedBarRow {
  /** The short x-axis tick (area code). */
  label: string;
  /** The full area name, for the tooltip and the accessible table. */
  title: string;
  href?: string;
  /** Counts aligned to the series order. */
  values: number[];
}
export interface GroupedBarData {
  series: BarSeries[];
  rows: GroupedBarRow[];
}

const areaHref = (base: string, areaId: string, year: number): string =>
  `${base}?area=${encodeURIComponent(areaId)}&year=${year}`;

/** Chart 1: work papers per audit area for the year, for the doughnut. */
export async function getIssuesPerArea(
  db: Client,
  organizationId: string,
  year: number,
  scope: DashboardScope,
): Promise<ChartDatum[]> {
  const confine = confineWp(scope);
  const res = await db.execute({
    sql: `SELECT ${AA.area_code} AS code, ${AA.area_name} AS name,
                 ${WPa.audit_area_id} AS area_id, COUNT(*) AS n
            FROM work_papers wp
            JOIN audit_areas aa ON ${AA.audit_area_id} = ${WPa.audit_area_id}
                 AND ${AA.organization_id} = ${WPa.organization_id}
           WHERE ${WPa.organization_id} = ? AND ${WPa.year} = ?${confine.clause}
        GROUP BY ${WPa.audit_area_id}
        ORDER BY n DESC`,
    args: [organizationId, year, ...confine.args],
  });
  return res.rows.map((r) => ({
    label: String(r.code ?? r.name ?? 'Unassigned'),
    value: num(r.n),
    href: areaHref('/work-papers', String(r.area_id), year),
  }));
}

/** Chart 2: work papers per audit area split by risk rating, for the grouped bar. */
export async function getRiskPerArea(
  db: Client,
  organizationId: string,
  year: number,
  scope: DashboardScope,
): Promise<GroupedBarData> {
  const confine = confineWp(scope);
  const res = await db.execute({
    sql: `SELECT ${AA.area_code} AS code, ${AA.area_name} AS name,
                 ${WPa.audit_area_id} AS area_id,
                 SUM(CASE WHEN UPPER(${WPa.risk_rating}) = 'EXTREME' THEN 1 ELSE 0 END) AS extreme,
                 SUM(CASE WHEN UPPER(${WPa.risk_rating}) = 'HIGH' THEN 1 ELSE 0 END) AS high,
                 SUM(CASE WHEN UPPER(${WPa.risk_rating}) = 'MEDIUM' THEN 1 ELSE 0 END) AS medium,
                 SUM(CASE WHEN UPPER(${WPa.risk_rating}) = 'LOW' THEN 1 ELSE 0 END) AS low
            FROM work_papers wp
            JOIN audit_areas aa ON ${AA.audit_area_id} = ${WPa.audit_area_id}
                 AND ${AA.organization_id} = ${WPa.organization_id}
           WHERE ${WPa.organization_id} = ? AND ${WPa.year} = ?${confine.clause}
        GROUP BY ${WPa.audit_area_id}
        ORDER BY ${AA.area_code}`,
    args: [organizationId, year, ...confine.args],
  });
  const rows: GroupedBarRow[] = res.rows
    .map((r) => ({
      label: String(r.code ?? r.name ?? '?'),
      title: String(r.name ?? r.code ?? 'Audit area'),
      href: areaHref('/work-papers', String(r.area_id), year),
      values: [num(r.extreme), num(r.high), num(r.medium), num(r.low)],
    }))
    .filter((row) => row.values.some((v) => v > 0));
  return {
    series: [
      { label: 'Extreme', tone: 'extreme' },
      { label: 'High', tone: 'high' },
      { label: 'Medium', tone: 'medium' },
      { label: 'Low', tone: 'low' },
    ],
    rows,
  };
}

/** Chart 3: not-implemented action plans on high-risk findings, by area, for the pie. */
export async function getNotImplementedHighRisk(
  db: Client,
  organizationId: string,
  year: number,
  scope: DashboardScope,
): Promise<ChartDatum[]> {
  const confine = confineWp(scope);
  const res = await db.execute({
    sql: `SELECT ${AA.area_code} AS code, ${AA.area_name} AS name,
                 ${WPa.audit_area_id} AS area_id, COUNT(*) AS n
            FROM action_plans ap
            JOIN work_papers wp ON ${WPa.work_paper_id} = ${APa.work_paper_id}
                 AND ${WPa.organization_id} = ${APa.organization_id}
            JOIN audit_areas aa ON ${AA.audit_area_id} = ${WPa.audit_area_id}
                 AND ${AA.organization_id} = ${WPa.organization_id}
           WHERE ${APa.organization_id} = ? AND ${APa.status} = ?
             AND UPPER(${WPa.risk_rating}) IN ('HIGH', 'EXTREME') AND ${WPa.year} = ?${confine.clause}
        GROUP BY ${WPa.audit_area_id}
        ORDER BY n DESC`,
    args: [organizationId, NOT_IMPLEMENTED, year, ...confine.args],
  });
  return res.rows.map((r) => ({
    label: String(r.code ?? r.name ?? 'Unassigned'),
    value: num(r.n),
    href: areaHref('/action-plans', String(r.area_id), year),
  }));
}

/** Chart 4: action plans per audit area bucketed by status, for the grouped bar. */
export async function getActionPlanStatusPerArea(
  db: Client,
  organizationId: string,
  year: number,
  scope: DashboardScope,
): Promise<GroupedBarData> {
  const confine = confineWp(scope);
  const res = await db.execute({
    sql: `SELECT ${AA.area_code} AS code, ${AA.area_name} AS name,
                 ${WPa.audit_area_id} AS area_id,
                 SUM(CASE WHEN ${APa.status} = ? THEN 1 ELSE 0 END) AS not_impl,
                 SUM(CASE WHEN ${APa.status} IN ('Verified', 'Closed') THEN 1 ELSE 0 END) AS implemented,
                 SUM(CASE WHEN ${APa.status} = ? THEN 1 ELSE 0 END) AS not_due
            FROM action_plans ap
            JOIN work_papers wp ON ${WPa.work_paper_id} = ${APa.work_paper_id}
                 AND ${WPa.organization_id} = ${APa.organization_id}
            JOIN audit_areas aa ON ${AA.audit_area_id} = ${WPa.audit_area_id}
                 AND ${AA.organization_id} = ${WPa.organization_id}
           WHERE ${APa.organization_id} = ? AND ${WPa.year} = ?${confine.clause}
        GROUP BY ${WPa.audit_area_id}
        ORDER BY ${AA.area_code}`,
    args: [NOT_IMPLEMENTED, NOT_DUE, organizationId, year, ...confine.args],
  });
  const rows: GroupedBarRow[] = res.rows
    .map((r) => ({
      label: String(r.code ?? r.name ?? '?'),
      title: String(r.name ?? r.code ?? 'Audit area'),
      href: areaHref('/action-plans', String(r.area_id), year),
      values: [num(r.not_impl), num(r.implemented), num(r.not_due)],
    }))
    .filter((row) => row.values.some((v) => v > 0));
  return {
    series: [
      { label: 'Not implemented', tone: 'notimpl' },
      { label: 'Implemented', tone: 'impl' },
      { label: 'Not due', tone: 'notdue' },
    ],
    rows,
  };
}

export interface DashboardCharts {
  issuesPerArea: ChartDatum[];
  riskPerArea: GroupedBarData;
  notImplementedHighRisk: ChartDatum[];
  actionPlanStatusPerArea: GroupedBarData;
}

/** The four dashboard charts for the year, in one round of parallel queries. */
export async function getDashboardCharts(
  db: Client,
  organizationId: string,
  year: number,
  scope: DashboardScope,
): Promise<DashboardCharts> {
  return cached(
    db,
    // The confinement is in the key: a confined viewer's charts are different
    // figures, and must never be served from an unconfined viewer's entry.
    cacheKeys.dashboard(
      organizationId,
      'charts',
      `year=${year}:${affiliateScopeKey(scope.affiliateScope)}`,
    ),
    CACHE_TTL.dashboard,
    () => readDashboardCharts(db, organizationId, year, scope),
  );
}

async function readDashboardCharts(
  db: Client,
  organizationId: string,
  year: number,
  scope: DashboardScope,
): Promise<DashboardCharts> {
  const [issuesPerArea, riskPerArea, notImplementedHighRisk, actionPlanStatusPerArea] =
    await Promise.all([
      getIssuesPerArea(db, organizationId, year, scope),
      getRiskPerArea(db, organizationId, year, scope),
      getNotImplementedHighRisk(db, organizationId, year, scope),
      getActionPlanStatusPerArea(db, organizationId, year, scope),
    ]);
  return { issuesPerArea, riskPerArea, notImplementedHighRisk, actionPlanStatusPerArea };
}

export interface SidebarCounts {
  /**
   * Work papers awaiting this person's action (Build Prompt 62): their own
   * drafts and the findings sent back to them, plus, for a reviewer, what is
   * waiting on their review. It was the organisation's submitted count, which
   * badged an auditor with a number that was nobody's to act on but the head of
   * audit's.
   */
  pendingReview: number;
  myOverdue: number;
  myWorkPapers: number;
  myActionPlans: number;
  myObservations: number;
  responsesToReview: number;
  approvedQueue: number;
  /**
   * Requirements waiting on this person (Build Prompt 60): the ones they own
   * and have not answered, plus the answers waiting on them as the finding's
   * auditor. One badge, because a module has one entry, and both halves are the
   * same question: is anything here mine to act on?
   */
  myRequirements: number;
}

/** The sidebar badge counts (getSidebarCounts): organisation queues, and the signed-in user's own. */
export async function getSidebarCounts(
  db: Client,
  organizationId: string,
  userId: string,
  scope: AffiliateScope,
  /**
   * Whether this person reviews findings. A badge says "this many are yours to
   * act on", and what is yours depends on which side of the review you are on
   * (Build Prompt 62): a reviewer's queue is what has been submitted to them, an
   * auditor's is what has been sent back to them.
   */
  reviewer = false,
): Promise<SidebarCounts> {
  return cached(
    db,
    cacheKeys.dashboard(
      organizationId,
      'sidebar',
      `user=${userId}:${affiliateScopeKey(scope)}:reviewer=${reviewer ? 1 : 0}`,
    ),
    CACHE_TTL.dashboard,
    () => readSidebarCounts(db, organizationId, userId, scope, reviewer),
  );
}

async function readSidebarCounts(
  db: Client,
  organizationId: string,
  userId: string,
  scope: AffiliateScope,
  reviewer: boolean,
): Promise<SidebarCounts> {
  const like = ownerLike(userId);
  const wpConfine = affiliatePredicate(scope, cols(C.work_papers, 'wp').affiliate_code);
  const apConfine = affiliatePredicate(scope, AP.affiliate_code);
  const [wp, ap, req] = await Promise.all([
    db.execute({
      sql: `SELECT
              SUM(CASE
                    WHEN ${WPa.assigned_auditor_id} = ?
                     AND ${WPa.status} IN ('Draft', 'Revision Required') THEN 1
                    WHEN ? = 1 AND ${WPa.status} IN ('Submitted', 'Under Review') THEN 1
                    ELSE 0 END) AS pending_review,
              SUM(CASE WHEN ${WPa.prepared_by_id} = ? THEN 1 ELSE 0 END) AS my_work_papers,
              SUM(CASE WHEN ${WPa.status} = 'Response Received' THEN 1 ELSE 0 END) AS responses_to_review,
              SUM(CASE WHEN ${WPa.status} = 'Sent to Auditee' AND EXISTS (
                    SELECT 1 FROM work_paper_responsibles r WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}
                      AND ${RESP.user_id} = ?) THEN 1 ELSE 0 END) AS my_observations,
              SUM(CASE WHEN ${WPa.status} = 'Approved' AND EXISTS (
                    SELECT 1 FROM work_paper_responsibles r WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}
                      ) THEN 1 ELSE 0 END) AS approved_queue
            FROM work_papers wp WHERE ${WPa.organization_id} = ?${wpConfine.clause}`,
      args: [userId, reviewer ? 1 : 0, userId, userId, organizationId, ...wpConfine.args],
    }),
    db.execute({
      sql: `SELECT
              SUM(CASE WHEN (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ? THEN 1 ELSE 0 END) AS my_action_plans,
              SUM(CASE WHEN (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ? AND ${overdueClause('action_plans')} THEN 1 ELSE 0 END) AS my_overdue
            FROM action_plans WHERE ${AP.organization_id} = ?${apConfine.clause}`,
      args: [like, like, ...NOT_OVERDUE_STATUSES, organizationId, ...apConfine.args],
    }),
    // Requirements this person still has to act on: an open one they own with
    // nothing provided or a further question outstanding, or one of their own
    // findings with a round waiting to be read. A closed requirement is nobody's
    // move, so it never shows.
    db.execute({
      sql: `SELECT COUNT(*) AS mine
              FROM work_paper_requirements r
             WHERE ${R.organization_id} = ? AND ${R.deleted_at} IS NULL
               AND ${R.closed_at} IS NULL
               AND (
                 (EXISTS (SELECT 1 FROM requirement_owners o
                           WHERE ${RO.requirement_id} = ${R.requirement_id} AND ${RO.user_id} = ?)
                  AND COALESCE((SELECT ${RS.review_status} FROM requirement_submissions sub
                                 WHERE ${RS.requirement_id} = ${R.requirement_id}
                              ORDER BY COALESCE(${RS.round_number}, 0) DESC,
                                       ${RS.submitted_at} DESC LIMIT 1), 'MORE_INFO') = 'MORE_INFO')
                 OR
                 (EXISTS (SELECT 1 FROM work_papers wp
                           WHERE wp.work_paper_id = ${R.work_paper_id}
                             AND wp.assigned_auditor_id = ?)
                  AND (SELECT ${RS.review_status} FROM requirement_submissions sub
                        WHERE ${RS.requirement_id} = ${R.requirement_id}
                     ORDER BY COALESCE(${RS.round_number}, 0) DESC,
                              ${RS.submitted_at} DESC LIMIT 1) = 'PENDING')
               )`,
      args: [organizationId, userId, userId],
    }),
  ]);

  const w = wp.rows[0] ?? {};
  const a = ap.rows[0] ?? {};
  return {
    pendingReview: num(w.pending_review),
    myWorkPapers: num(w.my_work_papers),
    responsesToReview: num(w.responses_to_review),
    myObservations: num(w.my_observations),
    approvedQueue: num(w.approved_queue),
    myActionPlans: num(a.my_action_plans),
    myOverdue: num(a.my_overdue),
    myRequirements: num(req.rows[0]?.mine),
  };
}

/** Whether the user has any overdue action plan, for the auditee default landing. */
export async function hasMyOverdue(
  db: Client,
  organizationId: string,
  userId: string,
  scope: AffiliateScope,
): Promise<boolean> {
  const confine = affiliatePredicate(scope, AP.affiliate_code);
  const res = await db.execute({
    sql: `SELECT 1 FROM action_plans
           WHERE ${AP.organization_id} = ? AND (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ?
             AND ${overdueClause('action_plans')}${confine.clause}
           LIMIT 1`,
    args: [organizationId, ownerLike(userId), ...NOT_OVERDUE_STATUSES, ...confine.args],
  });
  return res.rows.length > 0;
}
