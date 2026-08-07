/**
 * SUPER_ADMIN access-control administration: read the roles and their permission
 * matrix, and write a role's grants to role_permissions. The permission model is
 * shared reference data (not tenant data), keyed by role_code, module_code and
 * action_code, so this is not organisation-scoped. SUPER_ADMIN is never modified
 * here; it always holds the full matrix.
 *
 * The write is one `db.batch(..., 'write')`, never a statement per cell. That is
 * not a performance nicety: the old loop issued 54 sequential upserts with no
 * transaction around them, so a single refused grant left the role three
 * quarters saved in a state the administrator never chose and could not see
 * (audit finding AC-03, `grc/docs/access-control-audit.md`). A batch is one
 * atomic round trip: the whole matrix applies, or none of it does, and the
 * caller gets a real error to show.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { buildMatrix, type PermissionMatrix, type MatrixRow } from '@grc/auth/rbac';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '@grc/auth/permissionModules';
import { C, cols } from '@grc/schema/columns';

const RP = cols(C.role_permissions);
const PM = cols(C.permission_modules);
const PA = cols(C.permission_actions);
const R = cols(C.roles);

/** The role codes, from the roles table, falling back to those with grants. */
export async function listRoleCodes(db: Client): Promise<string[]> {
  try {
    const res = await db.execute({
      sql: `SELECT ${R.role_code} FROM roles ORDER BY ${R.role_code}`,
      args: [],
    });
    const codes = res.rows.map((r) => String(r.role_code)).filter(Boolean);
    if (codes.length > 0) return codes;
  } catch {
    // fall back to the roles that carry grants
  }
  const res = await db.execute({
    sql: `SELECT DISTINCT ${RP.role_code} FROM role_permissions ORDER BY ${RP.role_code}`,
    args: [],
  });
  return res.rows.map((r) => String(r.role_code)).filter(Boolean);
}

/** One role's permission matrix, read fresh from role_permissions. */
export async function getRoleMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
  const res = await db.execute({
    sql: `SELECT ${RP.module_code}, ${RP.action_code}, ${RP.is_allowed}
            FROM role_permissions WHERE ${RP.role_code} = ?`,
    args: [roleCode],
  });
  const rows: MatrixRow[] = res.rows.map((r) => ({
    moduleCode: String(r.module_code ?? ''),
    actionCode: String(r.action_code ?? ''),
    isAllowed: Number(r.is_allowed ?? 0) === 1,
  }));
  return buildMatrix(rows);
}

/** One cell of the matrix as the save endpoint read it off the form. */
export interface RoleGrant {
  moduleCode: string;
  actionCode: string;
  isAllowed: boolean;
}

/**
 * The reference rows every grant depends on, as batch statements.
 *
 * `role_permissions.module_code` and `.action_code` reference
 * `permission_modules` and `permission_actions`, and foreign keys are enforced
 * on every connection (`src/lib/grc/db.ts`), so a grant on a module the lookup
 * table does not hold is refused. The module catalogue in
 * `auth/permissionModules.ts` is what the code enforces, so the save creates
 * whatever of it the database is missing, in the same batch and immediately
 * before the grants that need it.
 *
 * Each insert is guarded by `WHERE NOT EXISTS` rather than written as
 * `INSERT OR IGNORE`, because the two are only equivalent when the code column
 * carries a unique index. That index is implied by the foreign key, but the
 * dictionary records no constraints and this must be idempotent either way: a
 * plain `OR IGNORE` against a table with no unique index would add a duplicate
 * row on every save. A row that already exists is left exactly as the database
 * has it, name and description included, so this can never overwrite live
 * reference data; it only ever supplies what is missing.
 */
function referenceRowStatements(): InStatement[] {
  const statements: InStatement[] = [];
  for (const module of PERMISSION_MODULES) {
    statements.push({
      sql: `INSERT INTO permission_modules
              (${PM.module_code}, ${PM.module_name}, ${PM.description})
            SELECT ?, ?, ?
             WHERE NOT EXISTS (
                   SELECT 1 FROM permission_modules WHERE ${PM.module_code} = ?)`,
      args: [module.code, module.name, module.description, module.code],
    });
  }
  for (const action of PERMISSION_ACTIONS) {
    statements.push({
      sql: `INSERT INTO permission_actions (${PA.action_code}, ${PA.action_name})
            SELECT ?, ?
             WHERE NOT EXISTS (
                   SELECT 1 FROM permission_actions WHERE ${PA.action_code} = ?)`,
      args: [action.code, action.name, action.code],
    });
  }
  return statements;
}

/**
 * Replace one role's whole permission matrix, atomically.
 *
 * The submitted grants are the complete picture the administrator saw on the
 * screen, so the role's existing rows are deleted and the submission written in
 * their place. Delete-then-insert rather than a per-cell upsert because it needs
 * no unique index to be correct, it leaves no row behind for a module that has
 * since left the catalogue, and it is the shape a batch can carry in one round
 * trip. Every statement runs inside the batch's transaction: any refusal rolls
 * the whole thing back, so the role is never left half saved.
 */
export async function saveRoleMatrix(
  db: Client,
  roleCode: string,
  grants: readonly RoleGrant[],
): Promise<void> {
  const statements: InStatement[] = referenceRowStatements();
  statements.push({
    sql: `DELETE FROM role_permissions WHERE ${RP.role_code} = ?`,
    args: [roleCode],
  });
  for (const grant of grants) {
    statements.push({
      sql: `INSERT INTO role_permissions
              (${RP.role_code}, ${RP.module_code}, ${RP.action_code}, ${RP.is_allowed})
            VALUES (?, ?, ?, ?)`,
      args: [roleCode, grant.moduleCode, grant.actionCode, grant.isAllowed ? 1 : 0],
    });
  }
  await db.batch(statements, 'write');
}
