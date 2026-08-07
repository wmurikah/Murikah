/**
 * Role based access control for the GRC platform, a permission matrix (not a
 * permission-code list), ported from PermissionService.gs.
 *
 * A user carries a single `users.role_code` (there is no user_roles junction).
 * The grants live in `role_permissions(role_code, module_code, action_code,
 * is_allowed)`. getPermissionMatrix builds `{ module: { action: boolean } }`;
 * the middleware attaches the matrix to locals.grc, and the server-side gate is
 * `can(locals, action, module)` with the source aliases (view to read,
 * WORK_PAPERS to WORK_PAPER). A SUPER_ADMIN and a platform owner hold the full
 * matrix. The pure core lives in matrix.ts.
 *
 * The matrix is not cached, at any layer, deliberately (Build Prompt 43, AC-04).
 * It is one indexed SELECT on a small reference table, and the request already
 * makes several queries, so reading it fresh is cheap at this scale and correct
 * by construction: a permission change is in force at every edge on the very
 * next request, with no invalidation to propagate and nothing to go stale. What
 * was here before was a module-level Map with no expiry, which only the isolate
 * that served the save could ever clear, so an access change reached other edges
 * whenever they happened to recycle. If a measurement ever justifies caching
 * this, a 30 to 60 second TTL on a shared cache is the only acceptable
 * compromise; never an unbounded per-isolate map.
 */
import type { Client } from '@libsql/client/web';
import { buildMatrix, canMatrix, type PermissionMatrix, type MatrixRow } from './matrix';

export * from './matrix';

/** The permission matrix granted to a role, read fresh from role_permissions. */
export async function getPermissionMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
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
