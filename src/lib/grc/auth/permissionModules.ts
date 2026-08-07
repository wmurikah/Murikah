/**
 * The permission modules and actions, defined once.
 *
 * This file is the single source the whole platform reads from: the matrix
 * screen renders these modules, the save endpoint writes these grants, the save
 * itself ensures a `permission_modules` and a `permission_actions` row exists
 * for each of them, and `grc/test/smoke/seed.ts` seeds the smoke database from
 * the very same list. Two hand-maintained copies of this list is precisely the
 * drift that made every role save fail: the code enforced `CONFIG` and
 * `AUDIT_LOG`, the live `permission_modules` table held `NOTIFICATION` and
 * `SETUP`, both lists were nine long, and with `PRAGMA foreign_keys = ON`
 * (`src/lib/grc/db.ts`) the first grant for a module the table did not hold
 * violated the foreign key and killed the write (audit finding AC-05,
 * `grc/docs/access-control-audit.md`). Add a module here and nowhere else.
 *
 * The reconciliation is the union of the two lists, and each side of it was
 * decided rather than merged blindly:
 *
 * - `CONFIG` and `AUDIT_LOG` are enforced by the code (`CONFIG.read` is the
 *   door to every settings screen and `CONFIG.update` gates this very save), so
 *   the rows they need are created rather than the grants dropped. The database
 *   stays the source of truth for column names and shape; what the code
 *   enforces has to exist as reference data, and the save creates it.
 * - `NOTIFICATION` and `SETUP` were held by the table and read by nothing.
 *   Rather than orphan them (a row cannot simply be deleted while a
 *   `role_permissions` row still references it), both are now wired in
 *   `PAGE_PERMISSION_MAP`: `NOTIFICATION.read` opens the send queue and
 *   `SETUP.read` opens the setup screens. Both are additive alternatives beside
 *   the `CONFIG.read` that already opened those sections, so reconciling the
 *   lists takes no access away from anybody.
 *
 * `module_name` and `description` are the other two `permission_modules`
 * columns, and `action_name` the other `permission_actions` column, so a row
 * this file creates is complete rather than a bare code.
 *
 * No imports, so node strips the types and the unit tests run this directly.
 */

/**
 * The organisation id the platform-default grants are stored under.
 *
 * `role_permissions` is tenant-scoped as of Build Prompt 44: the effective key
 * is `(organization_id, role_code, module_code, action_code)`, and an
 * organisation resolves its own rows if it has any, else these defaults. The
 * value is the same inactive `GLOBAL` sentinel organisation the platform-wide
 * config rows already hang off (`repos/orgConfig.ts::GLOBAL_CONFIG_ORG`), on
 * purpose: one sentinel row for everything that belongs to the platform rather
 * than to a customer, so there is one thing to create and one thing to exclude
 * from organisation lists. It is declared here rather than imported from
 * `orgConfig.ts` only so this file stays free of imports.
 *
 * A real organisation can never collide with it: organisation ids are minted as
 * UUIDs at provisioning, and the sentinel row is `is_active = 0`, so it never
 * appears in a switcher or an organisation list.
 */
export const PLATFORM_DEFAULT_ORG = 'GLOBAL';

export interface PermissionModuleDef {
  /** `permission_modules.module_code`, and the key the matrix is stored under. */
  readonly code: string;
  /** `permission_modules.module_name`: the human label for the row. */
  readonly name: string;
  /** `permission_modules.description`: what holding a grant on it means. */
  readonly description: string;
}

export interface PermissionActionDef {
  /** `permission_actions.action_code`, and the matrix column. */
  readonly code: string;
  /** `permission_actions.action_name`. */
  readonly name: string;
}

/** Every module the matrix may hold a grant on, and the reference row it needs. */
export const PERMISSION_MODULES: readonly PermissionModuleDef[] = [
  {
    code: 'WORK_PAPER',
    name: 'Work papers',
    description: 'Audit findings and their working papers.',
  },
  {
    code: 'ACTION_PLAN',
    name: 'Action plans',
    description: 'Remediation plans arising from findings.',
  },
  {
    code: 'AUDITEE_RESPONSE',
    name: 'Auditee responses',
    description: 'The auditee side of a finding: responses and proposed plans.',
  },
  {
    code: 'AUDIT_WORKBENCH',
    name: 'Audit workbench',
    description: 'The dashboard and the analytics the audit team works from.',
  },
  {
    code: 'REPORT',
    name: 'Reports',
    description: 'Management and board reporting, and their exports.',
  },
  {
    code: 'AI_ASSIST',
    name: 'AI assistance',
    description: 'The AI drafting, validation and analysis helpers.',
  },
  {
    code: 'NOTIFICATION',
    name: 'Notifications',
    description: 'The outbound send queue, its failures and its retries.',
  },
  {
    code: 'SETUP',
    name: 'Setup',
    description: 'Affiliates, the audit universe, dropdown vocabularies and general settings.',
  },
  {
    code: 'USER',
    name: 'Users',
    description: 'User administration within the organisation.',
  },
  {
    code: 'CONFIG',
    name: 'Configuration',
    description: 'Platform and organisation configuration, access control included.',
  },
  {
    code: 'AUDIT_LOG',
    name: 'Audit log',
    description: 'The activity trail of who did what, and when.',
  },
];

/** Every action a grant may be held for, and the reference row it needs. */
export const PERMISSION_ACTIONS: readonly PermissionActionDef[] = [
  { code: 'read', name: 'Read' },
  { code: 'create', name: 'Create' },
  { code: 'update', name: 'Update' },
  { code: 'delete', name: 'Delete' },
  { code: 'approve', name: 'Approve' },
  { code: 'export', name: 'Export' },
];
