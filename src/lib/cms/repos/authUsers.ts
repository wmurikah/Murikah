/**
 * Resolve a sign-in identity by email, for the two user types. Staff are the
 * `users` table (country-scoped, roles via user_roles with a cached role on the
 * session); customers are portal-enabled `contacts` (is_portal_user = 1),
 * carrying their own portal_role and scoped to their customer_id. Both store the
 * same pbkdf2 password hash and optional TOTP secret, so one verifier and one
 * MFA step serve both.
 *
 * Column names come from the typed schema layer (@cms/schema/columns), so a wrong
 * name fails the build. Every lookup requires an active account.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const U = cols(C.users, 'u');
const UR = cols(C.user_roles, 'ur');
const CT = cols(C.contacts);

export type UserType = 'STAFF' | 'CUSTOMER';

export interface AuthIdentity {
  userType: UserType;
  userId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  /** The cached primary role code (staff role, or the contact's portal_role). */
  role: string | null;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mustChangePassword: boolean;
  /** Staff home country; null for customers. */
  countryCode: string | null;
  /** The customer a portal contact belongs to; null for staff. */
  customerId: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));

/** A staff sign-in identity, or null when the email is unknown or inactive. */
export async function resolveStaffByEmail(db: Client, email: string): Promise<AuthIdentity | null> {
  const res = await db.execute({
    sql: `SELECT ${U.user_id} AS user_id, ${U.email} AS email, ${U.first_name} AS first_name,
                 ${U.last_name} AS last_name, ${U.password_hash} AS password_hash,
                 ${U.mfa_enabled} AS mfa_enabled, ${U.mfa_secret} AS mfa_secret,
                 ${U.must_change_password} AS must_change_password, ${U.country_code} AS country_code,
                 (SELECT ${UR.role_code} FROM user_roles ur
                   WHERE ${UR.user_id} = ${U.user_id} LIMIT 1) AS role
            FROM users u
           WHERE ${U.email} = ? AND ${U.status} = 'ACTIVE'
           LIMIT 1`,
    args: [email],
  });
  const r = res.rows[0];
  if (!r || r.password_hash == null) return null;
  return {
    userType: 'STAFF',
    userId: String(r.user_id),
    email: String(r.email),
    displayName: [s(r.first_name), s(r.last_name)].filter(Boolean).join(' ') || String(r.email),
    passwordHash: String(r.password_hash),
    role: s(r.role),
    mfaEnabled: Number(r.mfa_enabled ?? 0) === 1,
    mfaSecret: s(r.mfa_secret),
    mustChangePassword: Number(r.must_change_password ?? 0) === 1,
    countryCode: s(r.country_code),
    customerId: null,
  };
}

/** A customer (portal contact) sign-in identity, or null when unknown or not portal-enabled. */
export async function resolveCustomerByEmail(
  db: Client,
  email: string,
): Promise<AuthIdentity | null> {
  const res = await db.execute({
    sql: `SELECT ${CT.contact_id} AS contact_id, ${CT.customer_id} AS customer_id,
                 ${CT.email} AS email, ${CT.first_name} AS first_name, ${CT.last_name} AS last_name,
                 ${CT.password_hash} AS password_hash, ${CT.portal_role} AS portal_role,
                 ${CT.mfa_enabled} AS mfa_enabled, ${CT.mfa_secret} AS mfa_secret,
                 ${CT.must_change_password} AS must_change_password
            FROM contacts
           WHERE ${CT.email} = ? AND ${CT.is_portal_user} = 1 AND ${CT.status} = 'ACTIVE'
           LIMIT 1`,
    args: [email],
  });
  const r = res.rows[0];
  if (!r || r.password_hash == null) return null;
  return {
    userType: 'CUSTOMER',
    userId: String(r.contact_id),
    email: String(r.email),
    displayName: [s(r.first_name), s(r.last_name)].filter(Boolean).join(' ') || String(r.email),
    passwordHash: String(r.password_hash),
    role: s(r.portal_role) ?? 'PORTAL_USER',
    mfaEnabled: Number(r.mfa_enabled ?? 0) === 1,
    mfaSecret: s(r.mfa_secret),
    mustChangePassword: Number(r.must_change_password ?? 0) === 1,
    countryCode: null,
    customerId: s(r.customer_id),
  };
}

/** Resolve either user type by email: staff first, then portal customer. */
export async function resolveByEmail(
  db: Client,
  email: string,
  want: UserType,
): Promise<AuthIdentity | null> {
  return want === 'STAFF' ? resolveStaffByEmail(db, email) : resolveCustomerByEmail(db, email);
}
