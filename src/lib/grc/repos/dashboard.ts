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
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { NOT_OVERDUE_STATUSES } from '@grc/reports/reportModel';
import { isAuditeeRole } from '@grc/dashboard/roleNav';

const WP = cols(C.work_papers);
const WPa = cols(C.work_papers, 'wp');
const AP = cols(C.action_plans);
const APa = cols(C.action_plans, 'ap');
const RESP = cols(C.work_paper_responsibles, 'r');
const AFF = cols(C.affiliates, 'aff');
const USR = cols(C.users, 'u');

export interface DashboardScope {
  userId: string;
  roleCode: string;
  isPlatformOwner: boolean;
  perms: string[];
}

/** An auditee (and not a platform owner) sees only their own items. */
function auditeeScoped(scope: DashboardScope): boolean {
  return isAuditeeRole(scope.roleCode) && !scope.isPlatformOwner;
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
  const auditee = auditeeScoped(scope);

  // Work papers and pending review.
  let workPapers = 0;
  let pendingReview = 0;
  if (auditee) {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS total FROM work_papers wp
             WHERE ${WPa.organization_id} = ?
               AND EXISTS (SELECT 1 FROM work_paper_responsibles r
                            WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}
                              AND ${RESP.user_id} = ?)`,
      args: [organizationId, scope.userId],
    });
    workPapers = num(res.rows[0]?.total);
    pendingReview = 0;
  } else {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS total,
                   SUM(CASE WHEN ${WP.status} = 'Submitted' THEN 1 ELSE 0 END) AS pending
              FROM work_papers WHERE ${WP.organization_id} = ?`,
      args: [organizationId],
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

  const [review, verify, responses] = await Promise.all([
    db.execute({
      sql: `SELECT ${WP.work_paper_id} AS id, ${WP.work_paper_ref} AS reference,
                   ${WP.observation_title} AS title, ${WP.risk_rating} AS risk
              FROM work_papers WHERE ${WP.organization_id} = ? AND ${WP.status} = 'Submitted'
          ORDER BY ${WP.updated_at} DESC LIMIT 10`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT ${AP.action_plan_id} AS id, COALESCE(${AP.action_ref}, ${AP.action_number}) AS reference,
                   ${AP.action_description} AS title
              FROM action_plans WHERE ${AP.organization_id} = ? AND ${AP.status} = 'Pending Verification'
          ORDER BY ${AP.updated_at} DESC LIMIT 10`,
      args: [organizationId],
    }),
    db.execute({
      sql: `SELECT ${WPa.work_paper_id} AS id, ${WPa.work_paper_ref} AS reference,
                   ${WPa.observation_title} AS title, ${WPa.risk_rating} AS risk,
                   ${AFF.affiliate_name} AS affiliate, ${WPa.revision_count} AS round
              FROM work_papers wp
              LEFT JOIN affiliates aff ON ${AFF.affiliate_code} = ${WPa.affiliate_code}
                   AND ${AFF.organization_id} = ${WPa.organization_id}
             WHERE ${WPa.organization_id} = ? AND ${WPa.status} = 'Response Received'
          ORDER BY ${WPa.updated_at} DESC LIMIT 10`,
      args: [organizationId],
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
  const apArgs: InArgs = [organizationId];
  let apWhere = `${AP.organization_id} = ?`;
  if (auditee) {
    apWhere += ` AND (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ?`;
    apArgs.push(ownerLike(scope.userId));
  }

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
): Promise<TeamPerformance> {
  const [productivity, affiliates] = await Promise.all([
    db.execute({
      sql: `SELECT ${USR.full_name} AS auditor, COUNT(*) AS n
              FROM work_papers wp
              JOIN users u ON ${USR.user_id} = ${WPa.assigned_auditor_id}
             WHERE ${WPa.organization_id} = ? AND ${WPa.assigned_auditor_id} IS NOT NULL
          GROUP BY ${WPa.assigned_auditor_id}
          ORDER BY n DESC LIMIT 10`,
      args: [organizationId],
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
             WHERE ${APa.organization_id} = ?
          GROUP BY ${WPa.affiliate_code}
          ORDER BY (open + closed) DESC LIMIT 10`,
      args: [...NOT_OVERDUE_STATUSES, ...NOT_OVERDUE_STATUSES, organizationId],
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

export interface SidebarCounts {
  pendingReview: number;
  myOverdue: number;
  myWorkPapers: number;
  myActionPlans: number;
  myObservations: number;
  responsesToReview: number;
  approvedQueue: number;
}

/** The sidebar badge counts (getSidebarCounts): organisation queues, and the signed-in user's own. */
export async function getSidebarCounts(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<SidebarCounts> {
  const like = ownerLike(userId);
  const [wp, ap] = await Promise.all([
    db.execute({
      sql: `SELECT
              SUM(CASE WHEN ${WPa.status} = 'Submitted' THEN 1 ELSE 0 END) AS pending_review,
              SUM(CASE WHEN ${WPa.prepared_by_id} = ? THEN 1 ELSE 0 END) AS my_work_papers,
              SUM(CASE WHEN ${WPa.status} = 'Response Received' THEN 1 ELSE 0 END) AS responses_to_review,
              SUM(CASE WHEN ${WPa.status} = 'Sent to Auditee' AND EXISTS (
                    SELECT 1 FROM work_paper_responsibles r WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}
                      AND ${RESP.user_id} = ?) THEN 1 ELSE 0 END) AS my_observations,
              SUM(CASE WHEN ${WPa.status} = 'Approved' AND EXISTS (
                    SELECT 1 FROM work_paper_responsibles r WHERE ${RESP.work_paper_id} = ${WPa.work_paper_id}
                      ) THEN 1 ELSE 0 END) AS approved_queue
            FROM work_papers wp WHERE ${WPa.organization_id} = ?`,
      args: [userId, userId, organizationId],
    }),
    db.execute({
      sql: `SELECT
              SUM(CASE WHEN (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ? THEN 1 ELSE 0 END) AS my_action_plans,
              SUM(CASE WHEN (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ? AND ${overdueClause('action_plans')} THEN 1 ELSE 0 END) AS my_overdue
            FROM action_plans WHERE ${AP.organization_id} = ?`,
      args: [like, like, ...NOT_OVERDUE_STATUSES, organizationId],
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
  };
}

/** Whether the user has any overdue action plan, for the auditee default landing. */
export async function hasMyOverdue(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM action_plans
           WHERE ${AP.organization_id} = ? AND (',' || IFNULL(${AP.owner_ids}, '') || ',') LIKE ?
             AND ${overdueClause('action_plans')}
           LIMIT 1`,
    args: [organizationId, ownerLike(userId), ...NOT_OVERDUE_STATUSES],
  });
  return res.rows.length > 0;
}
