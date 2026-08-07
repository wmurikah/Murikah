/**
 * SUPER_ADMIN access-control administration: read the roles and their permission
 * matrix, and write a grant to role_permissions. The permission model is shared
 * reference data (not tenant data), keyed by role_code, module_code and
 * action_code, so this is not organisation-scoped. SUPER_ADMIN is never modified
 * here; it always holds the full matrix. A save writes the role's whole matrix
 * in one atomic batch and then invalidates that role's cached matrix, so the
 * change takes effect on the next request no matter which path performed it and
 * can never half-apply (Build Prompt 43).
 */
import type { Client, InStatement } from '@libsql/client/web';
import {
  buildMatrix,
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
  type PermissionMatrix,
  type MatrixRow,
} from '@grc/auth/rbac';
import { invalidateRoleMatrix } from '@grc/cache/invalidate';

/** The role codes, from the roles table, falling back to those with grants. */
export async function listRoleCodes(db: Client): Promise<string[]> {
  try {
    const res = await db.execute({
      sql: `SELECT role_code FROM roles ORDER BY role_code`,
      args: [],
    });
    const codes = res.rows.map((r) => String(r.role_code)).filter(Boolean);
    if (codes.length > 0) return codes;
  } catch {
    // fall back to the roles that carry grants
  }
  const res = await db.execute({
    sql: `SELECT DISTINCT role_code FROM role_permissions ORDER BY role_code`,
    args: [],
  });
  return res.rows.map((r) => String(r.role_code)).filter(Boolean);
}

/** One role's permission matrix, read fresh (not the request cache). */
export async function getRoleMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
  const res = await db.execute({
    sql: `SELECT module_code, action_code, is_allowed
            FROM role_permissions WHERE role_code = ?`,
    args: [roleCode],
  });
  const rows: MatrixRow[] = res.rows.map((r) => ({
    moduleCode: String(r.module_code ?? ''),
    actionCode: String(r.action_code ?? ''),
    isAllowed: Number(r.is_allowed ?? 0) === 1,
  }));
  return buildMatrix(rows);
}

export interface Grant {
  moduleCode: string;
  actionCode: string;
  isAllowed: boolean;
}

/**
 * The statements that save a role's whole matrix, as one batch.
 *
 * Two things here are deliberate. The lookup rows come first: `role_permissions`
 * references `permission_modules` and `permission_actions`, foreign keys are on
 * (src/lib/grc/db.ts), and the code's module list had drifted from the seeded
 * reference data, so a grant for CONFIG or AUDIT_LOG met a parent row that did
 * not exist and took the whole save down with it. Reconciling the lookups in the
 * same batch makes the save self-healing on any database, without this build
 * having to know what the live tables already hold. INSERT OR IGNORE leaves
 * existing rows exactly as they are, including any module this build does not
 * use: reference data that predates it is not this endpoint's to remove, and an
 * unread lookup row grants nothing.
 *
 * Second, each grant is a delete-then-insert rather than an upsert. It needs no
 * read to decide which of the two it is, so the whole matrix is one round trip
 * rather than the 54 sequential ones this replaces.
 */
export function buildMatrixSaveStatements(roleCode: string, grants: Grant[]): InStatement[] {
  const statements: InStatement[] = [];

  for (const m of PERMISSION_MODULES) {
    statements.push({
      sql: `INSERT OR IGNORE INTO permission_modules (module_code, module_name, description)
            VALUES (?, ?, ?)`,
      args: [m.code, m.name, m.description],
    });
  }
  for (const a of PERMISSION_ACTIONS) {
    statements.push({
      sql: `INSERT OR IGNORE INTO permission_actions (action_code, action_name) VALUES (?, ?)`,
      args: [a.code, a.name],
    });
  }

  for (const g of grants) {
    statements.push({
      sql: `DELETE FROM role_permissions
             WHERE role_code = ? AND module_code = ? AND action_code = ?`,
      args: [roleCode, g.moduleCode, g.actionCode],
    });
    statements.push({
      sql: `INSERT INTO role_permissions (role_code, module_code, action_code, is_allowed)
            VALUES (?, ?, ?, ?)`,
      args: [roleCode, g.moduleCode, g.actionCode, g.isAllowed ? 1 : 0],
    });
  }
  return statements;
}

/**
 * Save a role's whole matrix atomically. The batch applies in full or not at
 * all, so a failure leaves the role exactly as it was rather than three quarters
 * changed. The role's cached matrix is cleared once, after the write lands, so
 * the change is in force on the very next request everywhere.
 */
export async function saveRoleMatrix(db: Client, roleCode: string, grants: Grant[]): Promise<void> {
  await db.batch(buildMatrixSaveStatements(roleCode, grants), 'write');
  await invalidateRoleMatrix(roleCode);
}
