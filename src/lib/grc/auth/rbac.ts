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
 * The matrix is not cached, anywhere, at any layer (Build Prompt 43). It is one
 * indexed SELECT on a small table and the request already makes several, so
 * reading it fresh is cheap at this scale and correct by construction: an
 * access change takes effect on the very next request, everywhere, with no
 * invalidation to propagate and no window in which one edge serves a matrix
 * another edge has already replaced. Should a measurement ever justify caching
 * it, a short TTL (30 to 60 seconds) is the only acceptable compromise, and a
 * per-isolate map with no lifetime is never one, because an invalidation cannot
 * cross isolates and the staleness is then unbounded. This sits beside what was
 * already true: the session, its validity and the user's identity are never
 * cached either, and are resolved fresh from the database on every request.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { buildMatrix, canMatrix, type PermissionMatrix, type MatrixRow } from './matrix';

export * from './matrix';

const RP = cols(C.role_permissions);

/** The permission matrix granted to a role, read fresh from role_permissions. */
export async function getPermissionMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
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
