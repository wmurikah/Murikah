/**
 * Role-based navigation and the default landing page, ported from the source
 * Scripts.html. Visibility is driven from the seeded permissions where the source
 * uses them and from the documented role sets where it hard-codes them. The
 * default landing sends auditee roles to their overdue action plans (or their
 * findings) and everyone else to the dashboard.
 *
 * Import-free (types only), so node strips types and unit-tests this directly.
 */

/** The auditee roles: their own section, and the auditee default landing. */
export const AUDITEE_ROLES = ['JUNIOR_STAFF', 'UNIT_MANAGER', 'SENIOR_MGMT'];

/** The roles that see the team-performance charts. */
export const TEAM_PERFORMANCE_ROLES = ['HEAD_OF_AUDIT', 'SENIOR_AUDITOR'];

/** The roles the source shows board reports to, on top of the REPORTS permission. */
export const BOARD_ROLES = ['BOARD_MEMBER', 'SUPER_ADMIN'];

export interface NavContext {
  roleCode: string;
  perms: string[];
  isPlatformOwner: boolean;
  /** Whether the subscription plan includes the AI feature (gates analytics and AI settings). */
  hasAi: boolean;
}

export function isAuditeeRole(roleCode: string): boolean {
  return AUDITEE_ROLES.includes(roleCode);
}

export function canSeeTeamPerformance(roleCode: string): boolean {
  return TEAM_PERFORMANCE_ROLES.includes(roleCode);
}

/** A permission held by the role, or by a platform owner (who holds everything). */
function hasPerm(ctx: NavContext, code: string): boolean {
  return ctx.isPlatformOwner || ctx.perms.includes(code);
}

/** Setup and the full workbench are the admin/super-admin view. */
function isAdmin(ctx: NavContext): boolean {
  return ctx.isPlatformOwner || ctx.roleCode === 'SUPER_ADMIN';
}

/** The sidebar badge counts, keyed as getSidebarCounts returns them. */
export type CountKey =
  | 'pendingReview'
  | 'myOverdue'
  | 'myWorkPapers'
  | 'myActionPlans'
  | 'myObservations'
  | 'responsesToReview'
  | 'approvedQueue';

export interface NavItemDef {
  label: string;
  href: string;
  icon: string;
  /** The badge count to show on this link, if any. */
  countKey?: CountKey;
  /** Render the badge in the alert colour (e.g. overdue). */
  alert?: boolean;
}
export interface NavGroupDef {
  label: string;
  icon: string;
  items: NavItemDef[];
}

/**
 * The navigation groups visible to the context, with empty groups dropped. The
 * dashboard and notifications are for everyone; the audit workbench follows the
 * work-paper and action-plan permissions; the auditee section shows for the
 * auditee roles or anyone who responds or reviews; board reports follow the
 * reports permission or the board roles; analytics is AI-gated for auditor
 * roles; setup is admin only, with AI settings when the plan includes AI.
 */
export function buildNav(ctx: NavContext): NavGroupDef[] {
  const show = {
    workPapers: hasPerm(ctx, 'WORK_PAPERS.view'),
    actionPlans: hasPerm(ctx, 'ACTION_PLANS.view'),
    auditee:
      isAuditeeRole(ctx.roleCode) ||
      hasPerm(ctx, 'AUDITEE.respond') ||
      hasPerm(ctx, 'WORK_PAPERS.review'),
    reports: hasPerm(ctx, 'REPORTS.view') || BOARD_ROLES.includes(ctx.roleCode) || isAdmin(ctx),
    analytics: ctx.hasAi && (hasPerm(ctx, 'WORK_PAPERS.view') || hasPerm(ctx, 'REPORTS.view')),
    setup: isAdmin(ctx),
  };

  const audit: NavItemDef[] = [];
  if (show.workPapers)
    audit.push({
      label: 'Work papers',
      href: '/work-papers',
      icon: 'workpapers',
      countKey: 'pendingReview',
    });
  if (show.actionPlans)
    audit.push({
      label: 'Action plans',
      href: '/action-plans',
      icon: 'actionplans',
      countKey: 'myOverdue',
      alert: true,
    });
  if (show.auditee)
    audit.push({
      label: 'Auditee responses',
      href: '/auditee-responses',
      icon: 'responses',
      countKey: 'responsesToReview',
    });
  if (show.reports) audit.push({ label: 'Reports', href: '/reports', icon: 'reports' });
  if (show.analytics) audit.push({ label: 'Analytics', href: '/analytics', icon: 'analytics' });

  const setup: NavItemDef[] = [];
  if (show.setup) {
    setup.push(
      { label: 'Affiliates', href: '/settings/affiliates', icon: 'affiliates' },
      { label: 'Audit universe', href: '/settings/audit-universe', icon: 'universe' },
      { label: 'Users', href: '/settings/users', icon: 'users' },
      { label: 'Roles', href: '/settings/access-control', icon: 'roles' },
      { label: 'Send queue', href: '/send-queue', icon: 'bell' },
      { label: 'Settings', href: '/settings', icon: 'settings' },
    );
    if (ctx.hasAi) setup.push({ label: 'AI settings', href: '/settings/ai', icon: 'ai' });
  }

  const groups: NavGroupDef[] = [
    {
      label: 'Overview',
      icon: 'overview',
      items: [
        { label: 'Dashboard', href: '/', icon: 'dashboard' },
        { label: 'Notifications', href: '/notifications', icon: 'bell' },
      ],
    },
    { label: 'Audit', icon: 'audit', items: audit },
    { label: 'Setup', icon: 'setup', items: setup },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The default landing page for the role. Auditee roles land on their overdue
 * action plans when they have any, else on their findings; a platform owner and
 * every other role land on the dashboard.
 */
export function defaultLandingPath(
  roleCode: string,
  isPlatformOwner: boolean,
  hasOverdue: boolean,
): string {
  if (isPlatformOwner || !isAuditeeRole(roleCode)) return '/';
  return hasOverdue ? '/action-plans?overdue=1' : '/work-papers';
}
