/**
 * The pure statement builder for a role's permission-matrix save (Build Prompt
 * 43), kept as a leaf beside the repository that runs it, the same shape as
 * provisioningDefaults.ts. Its only import is the equally pure permission
 * catalogue, so node strips the types and the unit tests run it directly: the
 * order and content of the batch are pinned without a database.
 *
 * The save replaces rather than patches. The screen submits every cell, so the
 * honest statement of intent is "these are the role's grants", not fifty-four
 * independent edits, and a DELETE followed by the INSERTs inside one batch is
 * atomic, idempotent, and needs no unique constraint the column dictionary
 * cannot confirm exists (grc/db/schema.md records columns, not keys).
 *
 * The batch first ensures the lookup rows the foreign keys need. A module the
 * code enforces but `permission_modules` does not hold makes every save fail
 * with foreign keys on (src/lib/grc/db.ts), which is exactly what AC-05 was. The
 * rows come from the same catalogue the code's MODULES come from, so the
 * self-heal can only ever insert a module the matrix genuinely grants, and no
 * manual migration stands between this fix and a working save. It mirrors the
 * GLOBAL config sentinel's self-heal in orgConfig.ts.
 */
import type { InStatement } from '@libsql/client/web';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../auth/permissionCatalogue.ts';

/**
 * The parameterised half of libSQL's InStatement. Narrowing to it (rather than
 * returning the string-or-object union) is what lets the unit tests read `sql`
 * and `args` off a built statement without casting.
 */
export type GrantStatement = Extract<InStatement, { sql: string }>;

/** One grant as the caller submitted it. */
export interface GrantInput {
  moduleCode: string;
  actionCode: string;
  isAllowed: boolean;
}

/**
 * Insert a lookup row only when it is missing. Written as INSERT ... SELECT ...
 * WHERE NOT EXISTS rather than INSERT OR IGNORE because the live table's unique
 * constraints are not recorded in the dictionary: this form is a no-op on an
 * existing row with or without one.
 */
function ensureLookupRow(
  table: string,
  keyColumn: string,
  columns: string[],
  values: string[],
): GrantStatement {
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')})
          SELECT ${placeholders}
           WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${keyColumn} = ?)`,
    args: [...values, values[0]],
  };
}

/**
 * The statements that make a role's matrix exactly `grants`, in the order they
 * must run: ensure the lookup rows the foreign keys need, clear the role's
 * existing grants, then write every submitted cell (a denied cell is stored as
 * 0, never left out, so the stored matrix is never partial).
 */
export function buildRoleMatrixStatements(
  roleCode: string,
  grants: readonly GrantInput[],
): GrantStatement[] {
  const statements: GrantStatement[] = [];

  for (const module of PERMISSION_MODULES) {
    statements.push(
      ensureLookupRow(
        'permission_modules',
        'module_code',
        ['module_code', 'module_name', 'description'],
        [module.code, module.name, module.description],
      ),
    );
  }
  for (const action of PERMISSION_ACTIONS) {
    statements.push(
      ensureLookupRow(
        'permission_actions',
        'action_code',
        ['action_code', 'action_name'],
        [action.code, action.name],
      ),
    );
  }

  statements.push({
    sql: `DELETE FROM role_permissions WHERE role_code = ?`,
    args: [roleCode],
  });
  for (const grant of grants) {
    statements.push({
      sql: `INSERT INTO role_permissions (role_code, module_code, action_code, is_allowed)
            VALUES (?, ?, ?, ?)`,
      args: [roleCode, grant.moduleCode, grant.actionCode, grant.isAllowed ? 1 : 0],
    });
  }
  return statements;
}
