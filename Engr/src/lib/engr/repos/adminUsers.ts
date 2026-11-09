/**
 * Users admin and their role assignments. Org-scoped reads and writes; every
 * write records an audit_logs row in the same transaction. Email is unique per
 * org, so a clash returns a conflict rather than throwing. Role assignment is
 * only touched when the actor may manage roles; the password hash is never read
 * back or rendered. Soft-deleted users (deleted_at) are excluded from every read.
 */
import type { Client } from '@libsql/client/web';
import { hashPassword, validatePasswordSecurity } from '@engr/auth/password';
import { effectiveRoleIds } from '@engr/repos/adminRoles';
import { authLink, issueAuthTokenWithMetadata } from '@engr/auth/tokens';
import {
  authMessageKeyReady,
  encryptAuthMessage,
  redactUserAuthMessages,
} from '@engr/auth/notificationMessages';
import {
  mayAssignRoleCode,
  mayManageTargetUser,
  type UserManagementScope,
} from '@engr/auth/adminPolicy';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AdminResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found' | 'forbidden'; message: string };

export interface UserRow {
  id: string;
  fullName: string;
  email: string;
  status: string;
  roleNames: string;
  roleCodes: string[];
  isPlatformOwner: boolean;
}

export interface UserDetail {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  roleIds: string[];
  roleCodes: string[];
  isPlatformOwner: boolean;
  mustChangePassword: boolean;
}

export interface UserInput {
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  password: string | null;
  roleIds: string[];
  assignRoles: boolean;
  managementScope: UserManagementScope;
  appOrigin: string;
  authMessageKey?: string;
}

export async function listUsersAdmin(db: Client, orgId: string): Promise<UserRow[]> {
  const res = await db.execute({
    sql: `SELECT u.id, u.full_name, u.email, u.status,
                 GROUP_CONCAT(r.name, ', ') AS role_names,
                 GROUP_CONCAT(r.code, ',') AS role_codes,
                 u.is_platform_owner
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
    roleCodes: r.role_codes === null ? [] : String(r.role_codes).split(',').filter(Boolean),
    isPlatformOwner: Number(r.is_platform_owner ?? 0) === 1,
  }));
}

export async function getUser(db: Client, orgId: string, id: string): Promise<UserDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, full_name, email, phone, status, must_change_password, is_platform_owner
            FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const roleRes = await db.execute({
    sql: `SELECT ur.role_id, r.code
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
    roleCodes: roleRes.rows.map((r) => String(r.code)),
    isPlatformOwner: Number(row.is_platform_owner ?? 0) === 1,
    mustChangePassword: Number(row.must_change_password ?? 0) === 1,
  };
}

const STATUSES = new Set(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']);

function validate(input: UserInput): string | null {
  if (!input.fullName) return 'A name is required.';
  if (!input.email) return 'An email is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

// Keep only the effective role ids for this org (its own roles, plus the shared
// defaults it has not cloned). Guards against assigning another org's roles and
// against assigning a shared default that this org has replaced with its own copy.
async function filterRoleIds(
  db: Client,
  orgId: string,
  roleIds: string[],
  scope: UserManagementScope,
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const allowed = await effectiveRoleIds(db, orgId);
  const roleRows = await db.execute({
    sql: `SELECT id, code FROM roles WHERE id IN (${roleIds.map(() => '?').join(',')})`,
    args: roleIds,
  });
  const policyAllowed = new Set(
    roleRows.rows
      .filter((row) => mayAssignRoleCode(scope, String(row.code)))
      .map((row) => String(row.id)),
  );
  return roleIds.filter((rid) => allowed.has(rid) && policyAllowed.has(rid));
}

export async function createUser(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: UserInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  if (input.password) {
    const passwordError = await validatePasswordSecurity(input.password);
    if (passwordError) return { ok: false, code: 'invalid', message: passwordError };
  }
  if (!input.password && !authMessageKeyReady(input.authMessageKey)) {
    return {
      ok: false,
      code: 'invalid',
      message: 'Invitation email is not configured. Contact the system administrator.',
    };
  }
  const roleIds = input.assignRoles
    ? await filterRoleIds(db, ctx.orgId, input.roleIds, input.managementScope)
    : [];
  if (input.assignRoles && roleIds.length !== input.roleIds.length) {
    return { ok: false, code: 'forbidden', message: 'One or more roles cannot be assigned.' };
  }
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const mustChange = input.password ? 1 : 0;
  const status = input.password ? input.status : 'INVITED';
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
        status,
        mustChange,
      ],
    });
    for (const roleId of roleIds) {
      await tx.execute({
        sql: `INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
        args: [id, roleId],
      });
    }
    if (!input.password) {
      const issued = await issueAuthTokenWithMetadata(tx, {
        orgId: ctx.orgId,
        userId: id,
        purpose: 'INVITE',
        createdBy: ctx.userId,
        lifetimeMinutes: 48 * 60,
      });
      const link = authLink(input.appOrigin, issued.value);
      const notificationId = newId();
      const body = await encryptAuthMessage(
        `You have been invited to Engineering Rhythm. Set your password within 48 hours: ${link}`,
        { id: notificationId, orgId: ctx.orgId, userId: id, templateKey: 'auth.invitation' },
        issued,
        input.authMessageKey!,
      );
      await tx.execute({
        sql: `INSERT INTO notifications
                (id, org_id, channel, recipient_user_id, to_address, template_key, subject, body,
                 entity_type, entity_id, status)
              VALUES (?, ?, 'EMAIL', ?, ?, 'auth.invitation', 'Your Engineering Rhythm invitation', ?,
                      'user', ?, 'QUEUED')`,
        args: [notificationId, ctx.orgId, id, input.email, body, id],
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
  if (input.password) {
    const passwordError = await validatePasswordSecurity(input.password);
    if (passwordError) return { ok: false, code: 'invalid', message: passwordError };
  }
  const target = await getUser(db, ctx.orgId, id);
  if (!target) return { ok: false, code: 'not_found', message: 'That user was not found.' };
  if (!mayManageTargetUser(input.managementScope, target.roleCodes, target.isPlatformOwner)) {
    return {
      ok: false,
      code: 'forbidden',
      message: 'That account requires a higher administrator.',
    };
  }
  const roleIds = input.assignRoles
    ? await filterRoleIds(db, ctx.orgId, input.roleIds, input.managementScope)
    : [];
  if (input.assignRoles && roleIds.length !== input.roleIds.length) {
    return { ok: false, code: 'forbidden', message: 'One or more roles cannot be assigned.' };
  }
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
        sql: `UPDATE users
                 SET password_hash = ?, must_change_password = 1,
                     session_version = session_version + 1
               WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        args: [passwordHash, id, ctx.orgId],
      });
      await tx.execute({
        sql: `UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'administrator password reset'
               WHERE user_id = ? AND revoked_at IS NULL`,
        args: [new Date().toISOString(), id],
      });
      await tx.execute({
        sql: `UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
        args: [new Date().toISOString(), id],
      });
      await redactUserAuthMessages(tx, ctx.orgId, id);
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'users.password.reset', 'user', ?, ?)`,
        args: [
          ctx.orgId,
          ctx.userId,
          id,
          JSON.stringify({ temporary_password: true, sessions_revoked: true }),
        ],
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
      // Database triggers revoke tracked sessions and advance session_version.
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
