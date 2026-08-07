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
 *
 * Caching the matrix is the one place speed is allowed near access control, and
 * it is fenced on both sides (Build Prompt 42). Every `role_permissions` write
 * invalidates that role's entry immediately, so a changed grant applies on the
 * very next request rather than at the next sign-in; and the lifetime is capped
 * at CACHE_TTL.roleMatrix (a few seconds) so an edge a delete has not yet
 * reached still cannot hold an old matrix for long. The matrix is per role and
 * carries no tenant or user data, so it sits in the platform namespace. Note
 * what is not here: the session, its validity and the user's identity are never
 * cached, and are resolved fresh from the database on every request.
 */
import type { Client } from '@libsql/client/web';
import { CACHE_TTL, cacheKeys, cached } from '@grc/cache';
import { invalidateRoleMatrix } from '@grc/cache/invalidate';
import { buildMatrix, canMatrix, type PermissionMatrix, type MatrixRow } from './matrix';

export * from './matrix';
export { invalidateRoleMatrix };

/** The permission matrix granted to a role, from role_permissions, cached per role. */
export async function getPermissionMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
  return cached(db, cacheKeys.roleMatrix(roleCode), CACHE_TTL.roleMatrix, async () => {
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
  });
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
