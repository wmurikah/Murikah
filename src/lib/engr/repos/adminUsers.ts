/**
 * Users admin and their role assignments. Org-scoped reads and writes; every
 * write records an audit_logs row in the same transaction. Email is unique per
 * org, so a clash returns a conflict rather than throwing. Role assignment is
 * only touched when the actor may manage roles; the password hash is never read
 * back or rendered. Soft-deleted users (deleted_at) are excluded from every read.
 */
import type { Client } from '@libsql/client/web';
import { hashPassword } from '@engr/auth/password';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AdminResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface UserRow {
  id: string;
  fullName: string;
  email: string;
  status: string;
  roleNames: string;
}

export interface UserDetail {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  roleIds: string[];
}

export interface UserInput {
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  password: string | null;
  roleIds: string[];
  assignRoles: boolean;
}

export async function listUsersAdmin(db: Client, orgId: string): Promise<UserRow[]> {
  const res = await db.execute({
    sql: `SELECT u.id, u.full_name, u.email, u.status,
                 GROUP_CONCAT(r.name, ', ') AS role_names
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id AND (r.org_id IS NULL OR r.org_id = u.org_id)
           WHERE u.org_id = ? AND u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY u.full_name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    fullName: String(r.full_name),
    email: String(r.email),
    status: String(r.status),
    roleNames: r.role_names === null ? '' : String(r.role_names),
  }));
}

export async function getUser(db: Client, orgId: string, id: string): Promise<UserDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, full_name, email, phone, status
            FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const roleRes = await db.execute({
    sql: `SELECT ur.role_id
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = ? AND (r.org_id IS NULL OR r.org_id = ?)`,
    args: [id, orgId],
  });
  return {
    id: String(row.id),
    fullName: String(row.full_name),
    email: String(row.email),
    phone: row.phone === null ? null : String(row.phone),
    status: String(row.status),
    roleIds: roleRes.rows.map((r) => String(r.role_id)),
  };
}

const STATUSES = new Set(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']);

function validate(input: UserInput): string | null {
  if (!input.fullName) return 'A name is required.';
  if (!input.email) return 'An email is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

// Keep only the role ids that belong to this org (system roles, org_id IS NULL,
// or this org's own roles). Guards against assigning another org's roles.
async function filterRoleIds(db: Client, orgId: string, roleIds: string[]): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const res = await db.execute({
    sql: `SELECT id FROM roles WHERE org_id IS NULL OR org_id = ?`,
    args: [orgId],
  });
  const allowed = new Set(res.rows.map((r) => String(r.id)));
  return roleIds.filter((rid) => allowed.has(rid));
}

export async function createUser(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: UserInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const roleIds = input.assignRoles ? await filterRoleIds(db, ctx.orgId, input.roleIds) : [];
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const mustChange = input.password ? 0 : 1;
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO users (id, org_id, full_name, email, phone, password_hash, status, must_change_password)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.fullName,
        input.email,
        input.phone,
        passwordHash,
        input.status,
        mustChange,
      ],
    });
    for (const roleId of roleIds) {
      await tx.execute({
        sql: `INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
        args: [id, roleId],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'users.create', 'user', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ full_name: input.fullName, email: input.email }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That email is already used.' };
    throw err;
  }
}

export async function updateUser(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: UserInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const roleIds = input.assignRoles ? await filterRoleIds(db, ctx.orgId, input.roleIds) : [];
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE users
               SET full_name = ?, email = ?, phone = ?, status = ?
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      args: [input.fullName, input.email, input.phone, input.status, id, ctx.orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That user was not found.' };
    }
    if (passwordHash) {
      await tx.execute({
        sql: `UPDATE users SET password_hash = ?, must_change_password = 0
               WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        args: [passwordHash, id, ctx.orgId],
      });
    }
    if (input.assignRoles) {
      await tx.execute({
        sql: `DELETE FROM user_roles WHERE user_id = ?`,
        args: [id],
      });
      for (const roleId of roleIds) {
        await tx.execute({
          sql: `INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
          args: [id, roleId],
        });
      }
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'users.update', 'user', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ full_name: input.fullName, email: input.email }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That email is already used.' };
    throw err;
  }
}
