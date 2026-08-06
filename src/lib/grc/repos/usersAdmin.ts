/**
 * Users administration for the Setup module, SUPER_ADMIN (or platform owner)
 * only. Manages the organisation's users: create with an initial password and
 * must_change_password, edit email, name, role and affiliate, reset the
 * password, and activate or deactivate. Every read and write is scoped to the
 * acting organization_id; column names come from the typed schema layer.
 * Password hashes are produced by the caller (auth/password.ts) and never
 * stored in the clear. Every account carries an email: it is the sign-in
 * identity and the address the universal second-factor code goes to (Build
 * Prompt 37), so create and edit alike require a valid, unique one.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const U = cols(C.users);

const s = (v: unknown): string | null => (v == null ? null : String(v));

export const USER_ACTIVE = 'ACTIVE';
export const USER_INACTIVE = 'INACTIVE';

export interface ManagedUser {
  userId: string;
  email: string;
  fullName: string | null;
  roleCode: string | null;
  affiliateCode: string | null;
  status: string;
  isActive: boolean;
  mustChangePassword: boolean;
  isPlatformOwner: boolean;
}

export interface UserInput {
  email: string;
  fullName: string;
  roleCode: string;
  affiliateCode: string | null;
  phone: string | null;
}

const ACTIVE = (status: string): boolean =>
  !['INACTIVE', 'DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED'].includes(
    (status || '').toUpperCase(),
  );

/** The organisation's users (excluding soft-deleted), platform owners last. */
export async function listUsers(db: Client, organizationId: string): Promise<ManagedUser[]> {
  const res = await db.execute({
    sql: `SELECT ${U.user_id} AS user_id, ${U.email} AS email, ${U.full_name} AS full_name,
                 ${U.role_code} AS role_code, ${U.affiliate_code} AS affiliate_code,
                 ${U.status} AS status, ${U.must_change_password} AS must_change_password,
                 ${U.is_platform_owner} AS is_platform_owner
            FROM users
           WHERE ${U.organization_id} = ? AND ${U.deleted_at} IS NULL
        ORDER BY ${U.is_platform_owner}, ${U.full_name}`,
    args: [organizationId],
  });
  return res.rows.map((r) => {
    const status = String(r.status ?? USER_ACTIVE);
    return {
      userId: String(r.user_id),
      email: String(r.email ?? ''),
      fullName: s(r.full_name),
      roleCode: s(r.role_code),
      affiliateCode: s(r.affiliate_code),
      status,
      isActive: ACTIVE(status),
      mustChangePassword: Number(r.must_change_password ?? 0) === 1,
      isPlatformOwner: Number(r.is_platform_owner ?? 0) === 1,
    };
  });
}

/** One user in the organisation, or null. Used to guard writes (never cross-org). */
export async function getManagedUser(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<ManagedUser | null> {
  const res = await db.execute({
    sql: `SELECT ${U.user_id} AS user_id, ${U.email} AS email, ${U.full_name} AS full_name,
                 ${U.role_code} AS role_code, ${U.affiliate_code} AS affiliate_code,
                 ${U.status} AS status, ${U.must_change_password} AS must_change_password,
                 ${U.is_platform_owner} AS is_platform_owner
            FROM users
           WHERE ${U.organization_id} = ? AND ${U.user_id} = ? AND ${U.deleted_at} IS NULL
           LIMIT 1`,
    args: [organizationId, userId],
  });
  const r = res.rows[0];
  if (!r) return null;
  const status = String(r.status ?? USER_ACTIVE);
  return {
    userId: String(r.user_id),
    email: String(r.email ?? ''),
    fullName: s(r.full_name),
    roleCode: s(r.role_code),
    affiliateCode: s(r.affiliate_code),
    status,
    isActive: ACTIVE(status),
    mustChangePassword: Number(r.must_change_password ?? 0) === 1,
    isPlatformOwner: Number(r.is_platform_owner ?? 0) === 1,
  };
}

/**
 * Whether an email is already taken in the organisation (any state). The
 * account being edited is excluded, so saving a user without changing their
 * address is never mistaken for a duplicate.
 */
export async function userEmailExists(
  db: Client,
  organizationId: string,
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM users
           WHERE ${U.organization_id} = ? AND lower(${U.email}) = ? AND ${U.deleted_at} IS NULL
             AND (? IS NULL OR ${U.user_id} <> ?) LIMIT 1`,
    args: [organizationId, email.toLowerCase(), exceptUserId ?? null, exceptUserId ?? ''],
  });
  return res.rows.length > 0;
}

/** Create a user with an initial (already hashed) password and must_change_password. */
export async function createUser(
  db: Client,
  organizationId: string,
  passwordHash: string,
  input: UserInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO users
            (${U.user_id}, ${U.organization_id}, ${U.email}, ${U.full_name}, ${U.password_hash},
             ${U.role_code}, ${U.affiliate_code}, ${U.phone}, ${U.status}, ${U.must_change_password},
             ${U.is_platform_owner}, ${U.created_at}, ${U.updated_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    args: [
      id,
      organizationId,
      input.email,
      input.fullName,
      passwordHash,
      input.roleCode,
      input.affiliateCode,
      input.phone,
      USER_ACTIVE,
      now,
      now,
    ],
  });
  return id;
}

/**
 * Edit a user's email, name, role, affiliate and phone. The email is editable
 * because every account must have a valid one: it is the sign-in identity and
 * where the second-factor code goes, so an account that somehow has none is
 * repaired here.
 */
export async function updateUser(
  db: Client,
  organizationId: string,
  userId: string,
  input: UserInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE users
             SET ${U.email} = ?, ${U.full_name} = ?, ${U.role_code} = ?, ${U.affiliate_code} = ?,
                 ${U.phone} = ?, ${U.updated_at} = ?
           WHERE ${U.organization_id} = ? AND ${U.user_id} = ?`,
    args: [
      input.email,
      input.fullName,
      input.roleCode,
      input.affiliateCode,
      input.phone,
      new Date().toISOString(),
      organizationId,
      userId,
    ],
  });
}

export async function setUserActive(
  db: Client,
  organizationId: string,
  userId: string,
  active: boolean,
): Promise<void> {
  await db.execute({
    sql: `UPDATE users SET ${U.status} = ?, ${U.updated_at} = ?
           WHERE ${U.organization_id} = ? AND ${U.user_id} = ?`,
    args: [active ? USER_ACTIVE : USER_INACTIVE, new Date().toISOString(), organizationId, userId],
  });
}

/** Reset a user's password to a new (already hashed) value and force a change. */
export async function resetUserPassword(
  db: Client,
  organizationId: string,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE users SET ${U.password_hash} = ?, ${U.must_change_password} = 1, ${U.updated_at} = ?
           WHERE ${U.organization_id} = ? AND ${U.user_id} = ?`,
    args: [passwordHash, new Date().toISOString(), organizationId, userId],
  });
}
