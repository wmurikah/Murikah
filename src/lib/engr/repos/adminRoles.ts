/**
 * Roles and their permissions, per organisation, with copy-on-write isolation.
 *
 * Nine roles ship as shared system defaults (roles.org_id IS NULL, is_system 1)
 * and are read by every organisation. The moment an organisation edits what a
 * shared role may do, that role is cloned into an org-scoped copy (same code and
 * name, org_id set, is_system 0), this organisation's user_roles are re-pointed
 * from the shared role to the copy, and the edit is applied to the copy. The
 * shared roles stay pristine for every other organisation; this one now owns its
 * copy outright. An organisation may also create wholly custom roles.
 *
 * "Effective roles" for an organisation are its own roles plus the shared roles
 * whose code it has not cloned, so a shared role and its clone are never both in
 * play. loadUserAuth already scopes with (org_id IS NULL OR org_id = ?), so once
 * user_roles points at the clone the filter resolves to exactly the copy. Every
 * change is org-scoped and audited.
 */
import type { Client } from '@libsql/client/web';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type RoleResult =
  | { ok: true; id: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** True while the organisation still uses the shared default (not yet cloned). */
  shared: boolean;
  permCount: number;
}

export interface PermissionRow {
  id: string;
  key: string;
  module: string;
  description: string | null;
}

export interface RoleEdit {
  id: string;
  code: string;
  name: string;
  description: string | null;
  shared: boolean;
  permKeys: string[];
}

// The organisation's own roles, plus the shared roles it has not cloned.
const EFFECTIVE = `
  SELECT id, org_id, code, name, description, is_system FROM roles WHERE org_id = ?
  UNION ALL
  SELECT id, org_id, code, name, description, is_system FROM roles
   WHERE org_id IS NULL AND code NOT IN (SELECT code FROM roles WHERE org_id = ?)`;

export async function listEffectiveRoles(db: Client, orgId: string): Promise<RoleRow[]> {
  const res = await db.execute({
    sql: `WITH eff AS (${EFFECTIVE})
          SELECT eff.id, eff.code, eff.name, eff.description, eff.org_id,
                 (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = eff.id) AS perm_count
            FROM eff
        ORDER BY eff.name`,
    args: [orgId, orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    shared: r.org_id == null,
    permCount: Number(r.perm_count ?? 0),
  }));
}

// The effective role ids for an organisation, used to bound role assignment.
export async function effectiveRoleIds(db: Client, orgId: string): Promise<Set<string>> {
  const res = await db.execute({
    sql: `WITH eff AS (${EFFECTIVE}) SELECT id FROM eff`,
    args: [orgId, orgId],
  });
  return new Set(res.rows.map((r) => String(r.id)));
}

// Effective roles as a simple pick list for assigning to a user.
export async function listAssignableRoles(
  db: Client,
  orgId: string,
): Promise<{ id: string; name: string; code: string }[]> {
  const res = await db.execute({
    sql: `WITH eff AS (${EFFECTIVE}) SELECT id, name, code FROM eff ORDER BY name`,
    args: [orgId, orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name), code: String(r.code) }));
}

export async function listPermissions(db: Client): Promise<PermissionRow[]> {
  const res = await db.execute({
    sql: `SELECT id, key, module, description FROM permissions ORDER BY module, key`,
    args: [],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    key: String(r.key),
    module: String(r.module),
    description: r.description == null ? null : String(r.description),
  }));
}

// A role for editing: it must be a shared role or one owned by this org.
export async function getRoleEdit(
  db: Client,
  orgId: string,
  roleId: string,
): Promise<RoleEdit | null> {
  const res = await db.execute({
    sql: `SELECT id, org_id, code, name, description FROM roles
           WHERE id = ? AND (org_id IS NULL OR org_id = ?) LIMIT 1`,
    args: [roleId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const perms = await db.execute({
    sql: `SELECT p.key AS key FROM role_permissions rp
            JOIN permissions p ON p.id = rp.permission_id
           WHERE rp.role_id = ?`,
    args: [roleId],
  });
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    shared: row.org_id == null,
    permKeys: perms.rows.map((r) => String(r.key)),
  };
}

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export async function createCustomRole(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: { code: string; name: string; description: string | null },
): Promise<RoleResult> {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!code || !CODE_RE.test(code))
    return {
      ok: false,
      code: 'invalid',
      message: 'A code of letters, digits and underscores is required.',
    };
  if (!name) return { ok: false, code: 'invalid', message: 'A name is required.' };

  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO roles (id, org_id, code, name, description, is_system) VALUES (?, ?, ?, ?, ?, 0)`,
      args: [id, ctx.orgId, code, name, input.description?.trim() || null],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'roles.create', 'role', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ code, name })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'A role with that code already exists.' };
    throw err;
  }
}

/**
 * Replace a role's permissions to exactly the given keys. If the role is a
 * shared default, it is first cloned into this organisation (copy-on-write) and
 * the organisation's user_roles are re-pointed to the copy; the edit then lands
 * on the copy. Returns the id of the role the organisation now owns, which
 * differs from the input id when a clone was made.
 */
export async function saveRolePermissions(
  db: Client,
  ctx: { orgId: string; userId: string },
  roleId: string,
  permissionKeys: string[],
): Promise<RoleResult> {
  const role = await db.execute({
    sql: `SELECT id, org_id, code, name, description FROM roles
           WHERE id = ? AND (org_id IS NULL OR org_id = ?) LIMIT 1`,
    args: [roleId, ctx.orgId],
  });
  const row = role.rows[0];
  if (!row) return { ok: false, code: 'not_found', message: 'That role was not found.' };
  const isShared = row.org_id == null;
  const code = String(row.code);

  // Resolve the submitted keys to permission ids, dropping anything unknown.
  const permIds =
    permissionKeys.length > 0
      ? (
          await db.execute({
            sql: `SELECT id FROM permissions WHERE key IN (${permissionKeys.map(() => '?').join(',')})`,
            args: permissionKeys,
          })
        ).rows.map((r) => String(r.id))
      : [];

  const tx = await db.transaction('write');
  try {
    let targetId = roleId;
    if (isShared) {
      // The organisation may already own a clone of this code (created earlier);
      // edit that rather than creating a duplicate. Otherwise clone now.
      const existing = await tx.execute({
        sql: `SELECT id FROM roles WHERE org_id = ? AND code = ? LIMIT 1`,
        args: [ctx.orgId, code],
      });
      if (existing.rows[0]) {
        targetId = String(existing.rows[0].id);
      } else {
        targetId = newId();
        await tx.execute({
          sql: `INSERT INTO roles (id, org_id, code, name, description, is_system) VALUES (?, ?, ?, ?, ?, 0)`,
          args: [
            targetId,
            ctx.orgId,
            code,
            String(row.name),
            row.description == null ? null : String(row.description),
          ],
        });
        // Re-point only this organisation's users from the shared role to the copy.
        await tx.execute({
          sql: `UPDATE user_roles SET role_id = ?
                 WHERE role_id = ? AND user_id IN (SELECT id FROM users WHERE org_id = ?)`,
          args: [targetId, roleId, ctx.orgId],
        });
      }
    }

    await tx.execute({ sql: `DELETE FROM role_permissions WHERE role_id = ?`, args: [targetId] });
    for (const pid of permIds) {
      await tx.execute({
        sql: `INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
        args: [targetId, pid],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'roles.permissions', 'role', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        targetId,
        JSON.stringify({
          code,
          clonedFromShared: isShared && targetId !== roleId,
          permissions: permissionKeys.length,
        }),
      ],
    });
    await tx.commit();
    return { ok: true, id: targetId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
