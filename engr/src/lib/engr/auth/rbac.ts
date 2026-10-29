/**
 * Role based access control for Engineering Rhythm.
 *
 * On login, a user's role codes and permission keys are loaded once (scoped to
 * their org) and cached in the session JWT. Per-request checks then read the
 * cached list with can(); no database round trip is needed to authorise a page
 * or an endpoint.
 */
import type { Client } from '@libsql/client/web';

export interface UserAuth {
  roles: string[]; // role codes, e.g. OWNER, ENGINEER
  perms: string[]; // permission keys, e.g. requests.create
}

/**
 * Load a user's role codes and permission keys, scoped to their org. System
 * roles carry org_id IS NULL; org-custom roles carry the org id, so both are
 * matched. Only this user's grants are returned.
 */
export async function loadUserAuth(db: Client, orgId: string, userId: string): Promise<UserAuth> {
  const roleRows = await db.execute({
    sql: `SELECT r.code AS code
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = ? AND (r.org_id IS NULL OR r.org_id = ?)`,
    args: [userId, orgId],
  });
  const permRows = await db.execute({
    sql: `SELECT DISTINCT p.key AS key
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            JOIN role_permissions rp ON rp.role_id = r.id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = ? AND (r.org_id IS NULL OR r.org_id = ?)`,
    args: [userId, orgId],
  });
  return {
    roles: roleRows.rows.map((row) => String(row.code)),
    perms: permRows.rows.map((row) => String(row.key)),
  };
}

/** True when the current session carries the permission key. */
export function can(locals: App.Locals, key: string): boolean {
  return locals.engr?.perms.includes(key) ?? false;
}

/**
 * Throw a 403 Response when the session lacks the permission. Endpoints wrap
 * their body in try/catch and return a thrown Response; pages should prefer
 * can() and render a friendly message instead of throwing.
 */
export function requirePermission(locals: App.Locals, key: string): void {
  if (!can(locals, key)) {
    throw new Response(JSON.stringify({ error: 'forbidden', permission: key }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
}
