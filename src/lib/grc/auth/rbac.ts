/**
 * Role based access control for the GRC platform, a permission matrix (not a
 * permission-code list), ported from PermissionService.gs.
 *
 * A user carries a single `users.role_code` (there is no user_roles junction).
 * The grants live in `role_permissions(role_code, module_code, action_code,
 * is_allowed)`. getPermissionMatrix builds `{ module: { action: boolean } }`,
 * cached per role; the middleware attaches the matrix to locals.grc, and the
 * server-side gate is `can(locals, action, module)` with the source aliases
 * (view to read, WORK_PAPERS to WORK_PAPER). A SUPER_ADMIN and a platform owner
 * hold the full matrix. The pure core lives in matrix.ts.
 */
import type { Client } from '@libsql/client/web';
import { buildMatrix, canMatrix, type PermissionMatrix, type MatrixRow } from './matrix';

export * from './matrix';

// The matrix is cached per role for the isolate; a grant change invalidates it.
const matrixCache = new Map<string, PermissionMatrix>();

/** The permission matrix granted to a role, from role_permissions, cached per role. */
export async function getPermissionMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
  const cached = matrixCache.get(roleCode);
  if (cached) return cached;
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
  const matrix = buildMatrix(rows);
  matrixCache.set(roleCode, matrix);
  return matrix;
}

/** Invalidate the cached matrix for a role (or all roles), after a grant change. */
export function invalidateRoleMatrix(roleCode?: string): void {
  if (roleCode) matrixCache.delete(roleCode);
  else matrixCache.clear();
}

/** True when the session's matrix grants the action on the module (aliases applied). */
export function can(locals: App.Locals, action: string, module: string): boolean {
  const matrix = locals.grc?.matrix;
  return matrix ? canMatrix(matrix, action, module) : false;
}

/**
 * Throw a 403 Response when the session's matrix lacks the grant. Endpoints wrap
 * their body in try/catch and return a thrown Response; pages should prefer
 * can() and render a friendly message instead of throwing.
 */
export function requirePermission(locals: App.Locals, action: string, module: string): void {
  if (!can(locals, action, module)) {
    throw new Response(JSON.stringify({ error: 'forbidden', module, action }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
}
