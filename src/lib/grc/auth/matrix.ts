/**
 * The RBAC permission matrix, ported from PermissionService.gs. The model is a
 * matrix, not a permission-code list: a role grants module and action pairs. This
 * module is the pure core (no imports, so node strips types and unit-tests it):
 * the modules and actions, the two source aliases, the matrix check, the page map
 * and the backward-compatible legacy-code derivation.
 *
 * A user has one role (users.role_code); there is no user_roles junction. The
 * grants live in role_permissions(role_code, module_code, action_code, is_allowed).
 */

export type PermissionMatrix = Record<string, Record<string, boolean>>;

export const MODULES = [
  'WORK_PAPER',
  'ACTION_PLAN',
  'AUDITEE_RESPONSE',
  'AUDIT_WORKBENCH',
  'REPORT',
  'AI_ASSIST',
  'USER',
  'CONFIG',
  'AUDIT_LOG',
] as const;

export const ACTIONS = ['read', 'create', 'update', 'delete', 'approve', 'export'] as const;

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
  'send-queue': [{ module: 'CONFIG', action: 'read' }],
  settings: [
    { module: 'CONFIG', action: 'read' },
    { module: 'USER', action: 'read' },
  ],
  'settings/general': [{ module: 'CONFIG', action: 'read' }],
  'settings/affiliates': [{ module: 'CONFIG', action: 'read' }],
  'settings/audit-universe': [{ module: 'CONFIG', action: 'read' }],
  'settings/dropdowns': [{ module: 'CONFIG', action: 'read' }],
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
