/**
 * The permission catalogue: the one source for the modules and actions the RBAC
 * matrix is built from (Build Prompt 43).
 *
 * This exists because two lists had drifted apart (AC-05). The code enforced
 * `CONFIG` and `AUDIT_LOG`; the reconstruction of the live `permission_modules`
 * carried `NOTIFICATION` and `SETUP` instead. Both lists were nine long, which is
 * what hid the divergence, and with foreign keys on (`src/lib/grc/db.ts`) writing
 * a module the lookup table does not hold makes every role save fail. So the code
 * list (`auth/matrix.ts`) and the seeded reference rows (`grc/test/smoke/seed.ts`)
 * are now generated from here and cannot diverge again.
 *
 * The reconciliation, deliberately (per `grc/db/schema.md`, the database is the
 * source of truth for *columns*; which reference rows should exist is a product
 * decision, and this is that decision written down):
 *
 * - `CONFIG` and `AUDIT_LOG` stay. They are what the gates actually read:
 *   `PAGE_PERMISSION_MAP` unlocks every Setup screen on `CONFIG`, and the audit
 *   trail on `AUDIT_LOG`. Removing them would silently unlock or lock those
 *   screens. The rows they need are ensured on the live table by the save path
 *   itself (`repos/permissionsAdmin.ts`), so no manual migration is required.
 * - `SETUP` goes. It is `CONFIG` under a second name; nothing reads it. Keeping
 *   both would let an administrator tick a grant and watch it do nothing, which
 *   is worse than not offering it.
 * - `NOTIFICATION` goes. Notifications are user-scoped: every user sees their
 *   own and nobody sees anybody else's, so there is no grant to make. The
 *   section is deliberately unmapped in `PAGE_PERMISSION_MAP` for that reason.
 *
 * No imports, so node strips the types and the unit tests run this directly, and
 * the smoke seed (which runs under node, not the bundler) can import it too.
 */

export interface PermissionModule {
  code: string;
  name: string;
  description: string;
}

export interface PermissionAction {
  code: string;
  name: string;
}

/**
 * Every module the matrix can grant, and therefore every module that must exist
 * as a `permission_modules` row. Declaration order is the column order on the
 * access-control screen.
 */
export const PERMISSION_MODULES: readonly PermissionModule[] = [
  { code: 'WORK_PAPER', name: 'Work papers', description: 'Audit findings and their workflow' },
  { code: 'ACTION_PLAN', name: 'Action plans', description: 'Remediation and follow-up' },
  {
    code: 'AUDITEE_RESPONSE',
    name: 'Auditee responses',
    description: 'Management responses to findings',
  },
  {
    code: 'AUDIT_WORKBENCH',
    name: 'Audit workbench',
    description: 'The dashboard and analytics views',
  },
  { code: 'REPORT', name: 'Reports', description: 'Board and management reporting' },
  { code: 'AI_ASSIST', name: 'AI assistance', description: 'Drafting, validation and insights' },
  { code: 'USER', name: 'Users', description: 'User administration within the organisation' },
  {
    code: 'CONFIG',
    name: 'Configuration',
    description: 'Setup: the audit universe, affiliates, vocabularies and settings',
  },
  { code: 'AUDIT_LOG', name: 'Audit log', description: 'The immutable activity trail' },
] as const;

/** Every action the matrix can grant, and therefore every `permission_actions` row. */
export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  { code: 'read', name: 'Read' },
  { code: 'create', name: 'Create' },
  { code: 'update', name: 'Update' },
  { code: 'delete', name: 'Delete' },
  { code: 'approve', name: 'Approve' },
  { code: 'export', name: 'Export' },
] as const;

/** The module codes alone, in display order. */
export const MODULE_CODES: readonly string[] = PERMISSION_MODULES.map((m) => m.code);

/** The action codes alone, in display order. */
export const ACTION_CODES: readonly string[] = PERMISSION_ACTIONS.map((a) => a.code);
