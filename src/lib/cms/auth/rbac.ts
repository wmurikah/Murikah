/**
 * Role-based access control, ported from the source 20_rbac.gs / 40_svc_rbac.gs.
 * A role's permission codes come from the seeded role_permissions matrix and are
 * cached per role (a short per-isolate TTL, since the Worker is stateless across
 * isolates but reuses one within a burst). `can(perms, code)` is the
 * server-authoritative gate every staff route uses; the customer portal uses the
 * contact's portal_role the same way. Column names come from the typed layer.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const RP = cols(C.role_permissions);

interface CacheEntry {
  perms: Set<string>;
  at: number;
}
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** The permission codes granted to a role, cached per role for a short window. */
export async function loadRolePermissions(db: Client, roleCode: string): Promise<Set<string>> {
  const hit = CACHE.get(roleCode);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.perms;
  const res = await db.execute({
    sql: `SELECT ${RP.permission_code} AS code FROM role_permissions WHERE ${RP.role_code} = ?`,
    args: [roleCode],
  });
  const perms = new Set(res.rows.map((r) => String(r.code)));
  CACHE.set(roleCode, { perms, at: Date.now() });
  return perms;
}

/** True when the permission set grants the code. */
export function can(perms: Set<string>, code: string): boolean {
  return perms.has(code);
}
