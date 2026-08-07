/**
 * Role based access control for the GRC platform, a permission matrix (not a
 * permission-code list), ported from PermissionService.gs.
 *
 * A user carries a single `users.role_code` (there is no user_roles junction).
 * The grants live in `role_permissions(organization_id, role_code, module_code,
 * action_code, is_allowed)`. getPermissionMatrix builds
 * `{ module: { action: boolean } }` for a role inside an organisation; the
 * middleware attaches the matrix to locals.grc, and the server-side gate is
 * `can(locals, action, module)` with the source aliases (view to read,
 * WORK_PAPERS to WORK_PAPER). A SUPER_ADMIN and a platform owner hold the full
 * matrix. The pure core lives in matrix.ts.
 *
 * The matrix is tenant data (Build Prompt 44). It was platform-wide, which meant
 * one customer's administrator rewrote every other customer's roles with a
 * single save (audit finding AC-01). An organisation now resolves its own rows
 * if it has any and the platform defaults otherwise, so an instance admin's edit
 * reaches their organisation and nowhere else. Both halves come back in one
 * query and `selectScopedRows` decides between them.
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
import {
  buildMatrix,
  canMatrix,
  selectScopedRows,
  PLATFORM_DEFAULT_ORG,
  type PermissionMatrix,
  type ScopedMatrixRow,
  type ScopedMatrixRows,
} from './matrix';

export * from './matrix';

const RP = cols(C.role_permissions);

/**
 * One role's grants in one organisation, plus the platform defaults, in a single
 * query. The caller decides between them through `selectScopedRows`, so the
 * fallback rule lives in one pure, tested function rather than in the SQL.
 */
async function readScopedRows(
  db: Client,
  roleCode: string,
  organizationId: string,
): Promise<ScopedMatrixRows> {
  const res = await db.execute({
    sql: `SELECT ${RP.organization_id}, ${RP.module_code}, ${RP.action_code}, ${RP.is_allowed}
            FROM role_permissions
           WHERE ${RP.role_code} = ? AND ${RP.organization_id} IN (?, ?)`,
    args: [roleCode, organizationId, PLATFORM_DEFAULT_ORG],
  });
  const rows: ScopedMatrixRow[] = res.rows.map((r) => ({
    organizationId: String(r.organization_id ?? ''),
    moduleCode: String(r.module_code ?? ''),
    actionCode: String(r.action_code ?? ''),
    isAllowed: Number(r.is_allowed ?? 0) === 1,
  }));
  return selectScopedRows(rows, organizationId, PLATFORM_DEFAULT_ORG);
}

/**
 * The permission matrix a role holds inside an organisation, read fresh: the
 * organisation's own grants if it has any, else the platform defaults.
 */
export async function getPermissionMatrix(
  db: Client,
  roleCode: string,
  organizationId: string,
): Promise<PermissionMatrix> {
  const scoped = await readScopedRows(db, roleCode, organizationId);
  return buildMatrix(scoped.rows);
}

/** The same read, keeping whether the organisation inherited, for the admin screen. */
export async function getScopedRoleMatrix(
  db: Client,
  roleCode: string,
  organizationId: string,
): Promise<{ matrix: PermissionMatrix; inherited: boolean }> {
  const scoped = await readScopedRows(db, roleCode, organizationId);
  return { matrix: buildMatrix(scoped.rows), inherited: scoped.inherited };
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
