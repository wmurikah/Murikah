/**
 * Role based access control for the GRC platform.
 *
 * A user carries a single `role_code` (not a join table). Permissions resolve
 * from that role through `role_permissions` to `permissions`, whose codes look
 * like `WORK_PAPERS.review`. The middleware loads the set once per request from
 * the DB-backed session and caches it on locals.grc; can() then reads the cached
 * list. Routes and actions gate with can(); a status change additionally passes
 * through the workflow engine (workflow/transitions.ts).
 */
import type { Client } from '@libsql/client/web';

/**
 * Load the permission codes granted to a role. Reference tables (roles,
 * permissions, role_permissions) define the product's access model and are
 * shared across organisations, so this is not org-scoped; the tenant rows a
 * permission governs are always org-scoped by the caller.
 */
export async function loadPermissions(db: Client, roleCode: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT p.permission_code AS code
            FROM role_permissions rp
            JOIN permissions p ON p.permission_code = rp.permission_code
           WHERE rp.role_code = ?`,
    args: [roleCode],
  });
  return res.rows.map((r) => String(r.code));
}

/** True when the current session carries the permission code (e.g. WORK_PAPERS.review). */
export function can(locals: App.Locals, code: string): boolean {
  return locals.grc?.perms.includes(code) ?? false;
}

/**
 * Throw a 403 Response when the session lacks the permission. Endpoints wrap
 * their body in try/catch and return a thrown Response; pages should prefer
 * can() and render a friendly message instead of throwing.
 */
export function requirePermission(locals: App.Locals, code: string): void {
  if (!can(locals, code)) {
    throw new Response(JSON.stringify({ error: 'forbidden', permission: code }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
}
