/**
 * The RBAC permission matrix, ported from PermissionService.gs. The model is a
 * matrix, not a permission-code list: a role grants module and action pairs. This
 * module is the pure core (its only import is the module catalogue beside it, so
 * node strips types and unit-tests it): the modules and actions, the two source
 * aliases, the matrix check, the page map and the backward-compatible legacy-code
 * derivation.
 *
 * A user has one role (users.role_code); there is no user_roles junction. The
 * grants live in role_permissions(role_code, module_code, action_code, is_allowed).
 *
 * The module and action lists are derived from `permissionModules.ts` rather
 * than restated here, so the code's list, the reference rows the save creates
 * and the smoke seed all come from one place and cannot drift apart again.
 */
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from './permissionModules.ts';

export * from './permissionModules.ts';

export type PermissionMatrix = Record<string, Record<string, boolean>>;

/** Every module code, in display order, from the single module catalogue. */
export const MODULES: readonly string[] = PERMISSION_MODULES.map((m) => m.code);

/** Every action code, in display order, from the same catalogue. */
export const ACTIONS: readonly string[] = PERMISSION_ACTIONS.map((a) => a.code);

// The two source aliases, applied before lookup: action `view` maps to `read`,
// and module `WORK_PAPERS` maps to `WORK_PAPER`.
const ACTION_ALIAS: Record<string, string> = { view: 'read' };
const MODULE_ALIAS: Record<string, string> = { WORK_PAPERS: 'WORK_PAPER' };

export function canonicalAction(action: string): string {
  return ACTION_ALIAS[action] ?? action;
}

export function canonicalModule(module: string): string {
  return MODULE_ALIAS[module] ?? module;
}

/** The matrix check: can(user, action, module) === matrix[module]?.[action] === true. */
export function canMatrix(matrix: PermissionMatrix, action: string, module: string): boolean {
  const m = canonicalModule(module);
  const a = canonicalAction(action);
  return matrix[m]?.[a] === true;
}

export interface PagePermission {
  module: string;
  action: string;
}

/**
 * Page slug to the grants that unlock it: holding ANY listed grant suffices.
 * The slugs are the real route sections under /grc (first path segment, or the
 * first two for /settings/*), so the map describes the deployed product and the
 * middleware can enforce it centrally. Pages keep their own, sometimes stricter,
 * gates (e.g. work-papers/new needs create); this map is the section door.
 *
 * Sections with only identity- or row-scoped access carry no entry and pass:
 * the dashboard (self-gates in the shell), notifications (user-scoped),
 * change-password, and settings/provision (platform owner, not a role grant).
 *
 * `NOTIFICATION` and `SETUP` are wired here (Build Prompt 43). Both are held by
 * the live `permission_modules` table and were read by nothing, so reconciling
 * the code's list to the database left two modules an administrator could grant
 * to no effect. They are added as alternatives beside the `CONFIG.read` that
 * already opened those sections, never in place of it, so a role that could
 * reach a screen before can still reach it.
 */
export const PAGE_PERMISSION_MAP: Record<string, PagePermission[]> = {
  'work-papers': [{ module: 'WORK_PAPER', action: 'read' }],
  'action-plans': [
    { module: 'ACTION_PLAN', action: 'read' },
    // An auditee proposing a plan reaches /action-plans/new on this grant alone.
    { module: 'AUDITEE_RESPONSE', action: 'create' },
  ],
  'auditee-responses': [
    // The queue serves the auditee (respond) and the reviewer (approve) sides.
    { module: 'AUDITEE_RESPONSE', action: 'create' },
    { module: 'AUDITEE_RESPONSE', action: 'read' },
    { module: 'WORK_PAPER', action: 'approve' },
  ],
  reports: [{ module: 'REPORT', action: 'read' }],
  analytics: [
    { module: 'WORK_PAPER', action: 'read' },
    { module: 'REPORT', action: 'read' },
  ],
  // The send queue is the notification queue, so the notification grant opens it.
  'send-queue': [
    { module: 'CONFIG', action: 'read' },
    { module: 'NOTIFICATION', action: 'read' },
  ],
  settings: [
    { module: 'CONFIG', action: 'read' },
    { module: 'USER', action: 'read' },
    { module: 'SETUP', action: 'read' },
  ],
  // The four organisation-level setup screens: the SETUP grant is what names
  // them, and CONFIG.read still opens them as it always did.
  'settings/general': [
    { module: 'CONFIG', action: 'read' },
    { module: 'SETUP', action: 'read' },
  ],
  'settings/affiliates': [
    { module: 'CONFIG', action: 'read' },
    { module: 'SETUP', action: 'read' },
  ],
  'settings/audit-universe': [
    { module: 'CONFIG', action: 'read' },
    { module: 'SETUP', action: 'read' },
  ],
  'settings/dropdowns': [
    { module: 'CONFIG', action: 'read' },
    { module: 'SETUP', action: 'read' },
  ],
  'settings/access-control': [{ module: 'CONFIG', action: 'read' }],
  'settings/ai': [{ module: 'CONFIG', action: 'read' }],
  'settings/email': [{ module: 'CONFIG', action: 'read' }],
  'settings/users': [{ module: 'USER', action: 'read' }],
};

/**
 * The map slug for an app path: the first segment, or the first two under
 * /settings ('/settings/users' stays distinct from the settings home). Returns
 * '' for the root.
 */
export function pageSlugForPath(appPath: string): string {
  const segments = appPath.split('/').filter((s) => s !== '');
  if (segments.length === 0) return '';
  if (segments[0] === 'settings' && segments.length > 1) return `settings/${segments[1]}`;
  return segments[0];
}

/**
 * Whether the matrix grants access to a mapped page slug. An unmapped slug is
 * allowed here: those sections gate on identity or row scope, on the page.
 */
export function pageAccess(matrix: PermissionMatrix, slug: string): boolean {
  const need = PAGE_PERMISSION_MAP[slug];
  if (!need) return true;
  return need.some((p) => canMatrix(matrix, p.action, p.module));
}

export interface MatrixRow {
  moduleCode: string;
  actionCode: string;
  isAllowed: boolean;
}

/** A role_permissions row with the organisation it belongs to. */
export interface ScopedMatrixRow extends MatrixRow {
  organizationId: string;
  /** `scope_to_affiliate`, the role's affiliate confinement (Build Prompt 45). */
  scopeToAffiliate: boolean;
}

/** Which rows a matrix was built from: the organisation's own, or the defaults. */
export interface ScopedMatrixRows {
  rows: MatrixRow[];
  /** True when the organisation has no rows of its own and inherits the defaults. */
  inherited: boolean;
  /**
   * Whether this role is confined to its user's affiliate. The flag is stored on
   * every grant row for the role, since `role_permissions` is the tenant-scoped
   * table and `roles` is not, so it is read as "any row set" rather than "all
   * rows set": the save writes the whole row set atomically and cannot leave
   * them disagreeing, and a hand-edited database then fails closed.
   */
  scopeToAffiliate: boolean;
}

/**
 * Choose between an organisation's own grants and the platform defaults
 * (Build Prompt 44).
 *
 * The rule is all-or-nothing per role, deliberately: if the organisation holds
 * any row for this role, those rows are the answer and the defaults are ignored
 * entirely. The alternative, merging cell by cell, would mean an administrator
 * who unticks a cell cannot tell whether they have revoked it or merely fallen
 * back to a default that grants it, and an access-control screen a reviewer
 * cannot read is worse than a coarse one. Falling back whole keeps the screen
 * answerable: either these are your organisation's grants, or these are the
 * platform's, and the screen says which.
 *
 * An empty `organizationId` (a platform owner inside no instance) resolves the
 * defaults, which is what they are looking at from above the customers.
 */
export function selectScopedRows(
  rows: ScopedMatrixRow[],
  organizationId: string,
  platformDefaultOrg: string,
): ScopedMatrixRows {
  const own = organizationId === '' ? [] : rows.filter((r) => r.organizationId === organizationId);
  const chosen = own.length > 0 ? own : rows.filter((r) => r.organizationId === platformDefaultOrg);
  return {
    rows: chosen,
    inherited: own.length === 0,
    scopeToAffiliate: chosen.some((r) => r.scopeToAffiliate),
  };
}

/** Build the nested matrix from role_permissions rows. */
export function buildMatrix(rows: MatrixRow[]): PermissionMatrix {
  const matrix: PermissionMatrix = {};
  for (const r of rows) {
    (matrix[r.moduleCode] ??= {})[r.actionCode] = r.isAllowed;
  }
  return matrix;
}

/** A matrix granting everything, for SUPER_ADMIN and platform owners. */
export function fullMatrix(): PermissionMatrix {
  const matrix: PermissionMatrix = {};
  for (const module of MODULES) {
    matrix[module] = {};
    for (const action of ACTIONS) matrix[module][action] = true;
  }
  return matrix;
}

// Backward compatibility: earlier modules gate with legacy permission codes such
// as WORK_PAPERS.view. Deriving them from the matrix keeps those checks working,
// matrix-driven, without rewriting every endpoint.
const LEGACY_MAP: Array<{ code: string; module: string; action: string }> = [
  { code: 'WORK_PAPERS.view', module: 'WORK_PAPER', action: 'read' },
  { code: 'WORK_PAPERS.create', module: 'WORK_PAPER', action: 'create' },
  { code: 'WORK_PAPERS.edit', module: 'WORK_PAPER', action: 'update' },
  { code: 'WORK_PAPERS.review', module: 'WORK_PAPER', action: 'approve' },
  // The work-paper workflow catalogue also gates on submit, approve and send.
  // Without these three the matrix grants them to nobody, so a finding can never
  // leave Draft, be approved, or reach the auditee. Submitting is an authoring
  // step (whoever may edit the draft may submit it); approving and sending are
  // the reviewer's, so both follow the approve grant.
  { code: 'WORK_PAPERS.submit', module: 'WORK_PAPER', action: 'update' },
  { code: 'WORK_PAPERS.approve', module: 'WORK_PAPER', action: 'approve' },
  { code: 'WORK_PAPERS.send', module: 'WORK_PAPER', action: 'approve' },
  { code: 'REQUIREMENTS.manage', module: 'WORK_PAPER', action: 'update' },
  { code: 'ACTION_PLANS.view', module: 'ACTION_PLAN', action: 'read' },
  { code: 'ACTION_PLANS.create', module: 'ACTION_PLAN', action: 'create' },
  { code: 'ACTION_PLANS.edit', module: 'ACTION_PLAN', action: 'update' },
  { code: 'ACTION_PLANS.close', module: 'ACTION_PLAN', action: 'approve' },
  { code: 'ACTION_PLANS.verify', module: 'ACTION_PLAN', action: 'approve' },
  { code: 'AUDITEE.respond', module: 'AUDITEE_RESPONSE', action: 'create' },
  { code: 'DASHBOARD.view', module: 'AUDIT_WORKBENCH', action: 'read' },
  { code: 'REPORTS.view', module: 'REPORT', action: 'read' },
  { code: 'REPORTS.board', module: 'REPORT', action: 'read' },
  // The setup surfaces gate on the matrix (CONFIG and USER); the navigation,
  // which reads legacy codes, follows the same grants through these two.
  { code: 'CONFIG.view', module: 'CONFIG', action: 'read' },
  { code: 'USERS.manage', module: 'USER', action: 'read' },
];

/** The legacy permission codes a matrix grants (for perms.includes call sites). */
export function deriveLegacyPerms(matrix: PermissionMatrix): string[] {
  return LEGACY_MAP.filter((l) => matrix[l.module]?.[l.action] === true).map((l) => l.code);
}
