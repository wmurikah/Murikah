/**
 * Role based access control for Engineering Rhythm.
 *
 * Live roles and permissions are loaded on every authenticated request so
 * suspension and grant changes take effect immediately. Group related reads
 * in one Turso batch rather than paying two network round trips.
 */
import type { Client, InStatement, ResultSet } from '@libsql/client/web';

export interface UserAuth {
  roles: string[]; // role codes, e.g. OWNER, ENGINEER
  perms: string[]; // permission keys, e.g. requests.create
}

/**
 * Load a user's role codes and permission keys, scoped to their org. System
 * roles carry org_id IS NULL; org-custom roles carry the org id, so both are
 * matched. Only this user's grants are returned.
 */
export function userAuthStatements(orgId: string, userId: string): [InStatement, InStatement] {
  return [
    {
      sql: `SELECT r.code AS code
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = ? AND (r.org_id IS NULL OR r.org_id = ?)`,
      args: [userId, orgId],
    },
    {
      sql: `SELECT DISTINCT p.key AS key
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            JOIN role_permissions rp ON rp.role_id = r.id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = ? AND (r.org_id IS NULL OR r.org_id = ?)`,
      args: [userId, orgId],
    },
  ];
}

export function userAuthFromRows(roleRows: ResultSet, permRows: ResultSet): UserAuth {
  return {
    roles: roleRows.rows.map((row) => String(row.code)),
    perms: permRows.rows.map((row) => String(row.key)),
  };
}

export async function loadUserAuth(db: Client, orgId: string, userId: string): Promise<UserAuth> {
  const [roleRows, permRows] = await db.batch(userAuthStatements(orgId, userId), 'read');
  return userAuthFromRows(roleRows, permRows);
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
