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
  /**
   * Whether an instance is being acted inside. False only for a platform owner
   * who has selected none, whose navigation is the platform's, not a module's.
   */
  instanceSelected?: boolean;
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

/**
 * The setup section follows the matrix, through the derived legacy codes: any
 * role granted CONFIG or USER read sees it (SUPER_ADMIN holds the full matrix,
 * so it always qualifies; a platform owner always passes).
 */
function isAdmin(ctx: NavContext): boolean {
  return (
    ctx.isPlatformOwner || ctx.perms.includes('CONFIG.view') || ctx.perms.includes('USERS.manage')
  );
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
 * roles; administration is admin only, with AI settings when the plan includes
 * AI and the platform group for a platform owner.
 *
 * Administration is grouped rather than listed (Build Prompt 52): Organisation
 * for who and what the audit covers, Configuration for how the application
 * behaves, Platform for what belongs to Murikah Labs. Every screen appears once
 * and only once, which is the whole of the change: nothing was dropped.
 *
 * A platform owner inside no instance sees none of that: every module needs an
 * acting organisation, so their navigation is the platform's own, the
 * all-instances view and provisioning, until they enter one.
 */
export function buildNav(ctx: NavContext): NavGroupDef[] {
  if (ctx.isPlatformOwner && ctx.instanceSelected === false) {
    return [
      {
        label: 'Platform',
        icon: 'overview',
        items: [
          { label: 'All organisations', href: '/platform', icon: 'affiliates' },
          { label: 'Provision organisation', href: '/settings/provision', icon: 'setup' },
        ],
      },
    ];
  }

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
  // Requirements is the one entry an auditee sees for a reason (Build Prompt
  // 58): being asked for a document is not a permission an administrator grants,
  // it is a row naming you, and the screen scopes itself to what the reader
  // owns. So it is offered to the audit side and to the auditee side alike, and
  // an owner who holds nothing else still has somewhere to provide it.
  if (show.workPapers || show.auditee)
    audit.push({ label: 'Requirements', href: '/requirements', icon: 'list' });
  if (show.reports) audit.push({ label: 'Reports', href: '/reports', icon: 'reports' });
  if (show.analytics) audit.push({ label: 'Analytics', href: '/analytics', icon: 'analytics' });

  // Administration is two different jobs, so it is two groups rather than one
  // long list (Build Prompt 52). Organisation is who and what the audit covers;
  // Configuration is how the application behaves. Every destination appears
  // exactly once, and the settings hub is the last entry rather than a second
  // route to the same screens.
  const organisation: NavItemDef[] = [];
  const configuration: NavItemDef[] = [];
  const platform: NavItemDef[] = [];
  if (show.setup) {
    organisation.push(
      { label: 'Affiliates', href: '/settings/affiliates', icon: 'affiliates' },
      { label: 'Audit universe', href: '/settings/audit-universe', icon: 'universe' },
      { label: 'Users', href: '/settings/users', icon: 'users' },
      { label: 'Roles', href: '/settings/access-control', icon: 'roles' },
    );
    configuration.push(
      { label: 'General settings', href: '/settings/general', icon: 'settings' },
      { label: 'Dropdowns', href: '/settings/dropdowns', icon: 'list' },
      { label: 'Email', href: '/settings/email', icon: 'mail' },
      { label: 'Evidence storage', href: '/settings/storage', icon: 'storage' },
    );
    if (ctx.hasAi) configuration.push({ label: 'AI settings', href: '/settings/ai', icon: 'ai' });
    configuration.push({ label: 'All settings', href: '/settings', icon: 'setup' });
  }
  // Provisioning a customer organisation is the platform owner's, and it stayed
  // reachable only from the settings grid. It has its own group here, so the two
  // authorities read apart on the screen as well as in the gate.
  if (ctx.isPlatformOwner) {
    platform.push(
      { label: 'All organisations', href: '/platform', icon: 'affiliates' },
      { label: 'Provision organisation', href: '/settings/provision', icon: 'plus' },
    );
  }

  const overview: NavItemDef[] = [
    { label: 'Dashboard', href: '/', icon: 'dashboard' },
    { label: 'Notifications', href: '/notifications', icon: 'bell' },
  ];
  // What is coming in and what is going out belong together. The send queue used
  // to sit in Setup under the same bell as Notifications, which read as the same
  // destination twice; it is neither a setting nor an inbox, and now says so.
  if (show.setup) overview.push({ label: 'Send queue', href: '/send-queue', icon: 'send' });

  const groups: NavGroupDef[] = [
    { label: 'Overview', icon: 'overview', items: overview },
    { label: 'Audit', icon: 'audit', items: audit },
    { label: 'Organisation', icon: 'affiliates', items: organisation },
    { label: 'Configuration', icon: 'setup', items: configuration },
    { label: 'Platform', icon: 'overview', items: platform },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The default landing page for the role. A platform owner is pinned to no
 * organisation, so they land on the all-instances view and choose an instance to
 * enter, never inside a customer's dashboard by default. Auditee roles land on
 * their overdue action plans when they have any, else on their findings; every
 * other role lands on the dashboard of the organisation they are pinned to.
 */
export function defaultLandingPath(
  roleCode: string,
  isPlatformOwner: boolean,
  hasOverdue: boolean,
): string {
  if (isPlatformOwner) return '/platform';
  if (!isAuditeeRole(roleCode)) return '/';
  return hasOverdue ? '/action-plans?overdue=1' : '/work-papers';
}
