/**
 * The key constraints the generated smoke database enforces (Build Prompt 43,
 * AC-06).
 *
 * `grc/db/schema.md` is a column dictionary: it is ground truth for what columns
 * exist, and records nothing about keys. So the smoke database used to create
 * every table as a bag of untyped columns with no constraints at all, which
 * meant no foreign-key, NOT NULL or duplicate-key violation could ever be caught
 * before deploy. That is precisely why the role save shipped broken: the smoke
 * test wrote `CONFIG` into `role_permissions` happily, while the live database,
 * with `PRAGMA foreign_keys = ON` (`src/lib/grc/db.ts`), refused it.
 *
 * This file is that missing half of the schema, declared deliberately rather
 * than guessed wholesale. It is intentionally narrow: the permission tables in
 * full (they are what the audit was about), and the primary keys and
 * organisation references on the tables the smoke test actually writes. A
 * constraint declared here must be one the live database is believed to hold, so
 * that a smoke failure means a real bug rather than a fiction of the harness.
 * When the live DDL is recovered, this is the file to reconcile against.
 *
 * Deliberately not declared, and why:
 *
 * - `affiliates` is keyed by (organization_id, affiliate_code), so the
 *   single-column `affiliate_code` on work papers and action plans cannot
 *   reference it. Declaring a composite key here would enforce nothing useful.
 * - `config` takes no composite key: it is shared storage whose row shape varies
 *   (settings, vocabularies, MFA records) and the upsert paths already guard it.
 * - Nothing gets a NOT NULL it does not need for the audit's sake. A NOT NULL
 *   guessed wrong fails the smoke test on a column the live table allows empty.
 */

export interface TableKeys {
  /** Columns forming the primary key. A single column becomes an inline PRIMARY KEY. */
  primaryKey?: string[];
  /** Columns that may not be null. */
  notNull?: string[];
  /** Column to the `table(column)` it references. */
  references?: Record<string, string>;
}

export const KEY_CONSTRAINTS: Record<string, TableKeys> = {
  // ---- The permission model, the subject of the audit ----------------------
  roles: { primaryKey: ['role_code'], notNull: ['role_name'] },
  permission_modules: { primaryKey: ['module_code'], notNull: ['module_name'] },
  permission_actions: { primaryKey: ['action_code'], notNull: ['action_name'] },
  role_permissions: {
    // The composite key is what makes a duplicate grant a failure rather than a
    // silently doubled row, and it is why the save replaces rather than patches.
    primaryKey: ['role_code', 'module_code', 'action_code'],
    notNull: ['is_allowed'],
    references: {
      role_code: 'roles(role_code)',
      module_code: 'permission_modules(module_code)',
      action_code: 'permission_actions(action_code)',
    },
  },

  // ---- The tenancy spine, so an org reference cannot dangle ----------------
  organizations: { primaryKey: ['organization_id'] },
  users: {
    primaryKey: ['user_id'],
    references: { organization_id: 'organizations(organization_id)' },
  },
  sessions: { primaryKey: ['session_id'] },
  config: { references: { organization_id: 'organizations(organization_id)' } },

  // ---- Setup entities the smoke test writes -------------------------------
  audit_areas: {
    primaryKey: ['audit_area_id'],
    references: { organization_id: 'organizations(organization_id)' },
  },
  sub_areas: {
    primaryKey: ['sub_area_id'],
    references: {
      organization_id: 'organizations(organization_id)',
      audit_area_id: 'audit_areas(audit_area_id)',
    },
  },

  // ---- The two core records the smoke test creates, edits and transitions --
  work_papers: {
    primaryKey: ['work_paper_id'],
    references: { organization_id: 'organizations(organization_id)' },
  },
  action_plans: {
    primaryKey: ['action_plan_id'],
    references: { organization_id: 'organizations(organization_id)' },
  },
};

/**
 * The column definitions for one table, with any declared keys applied, plus any
 * table-level clauses (a composite primary key) that must follow them.
 */
export function tableDefinition(name: string, columns: string[]): string {
  const keys = KEY_CONSTRAINTS[name];
  if (!keys) return columns.join(', ');

  const singleColumnPk = keys.primaryKey?.length === 1 ? keys.primaryKey[0] : null;
  const defs = columns.map((column) => {
    const parts = [column];
    if (column === singleColumnPk) parts.push('PRIMARY KEY');
    else if (keys.notNull?.includes(column)) parts.push('NOT NULL');
    const target = keys.references?.[column];
    if (target) parts.push(`REFERENCES ${target}`);
    return parts.join(' ');
  });

  if (keys.primaryKey && keys.primaryKey.length > 1) {
    defs.push(`PRIMARY KEY (${keys.primaryKey.join(', ')})`);
  }
  return defs.join(', ');
}
