import type { Client } from '@libsql/client/web';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import {
  normalizeIdentityEmail,
  classifyIdentityEmail,
  emailDomain,
  isRegistrationIssuer,
} from '../auth/identityPolicy.ts';
import type { IdentityProvider } from '../auth/oidc.ts';

export async function issuePasswordReset(
  db: Client,
  input: {
    email: string;
    tokenHash: string;
    now: Date;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<{ issued: boolean; userId?: string }> {
  const found = await db.execute({
    sql: `SELECT u.user_id FROM users u JOIN auth_credentials c ON c.user_id=u.user_id
          WHERE u.email=? AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL LIMIT 1`,
    args: [input.email],
  });
  const userId = found.rows[0]?.user_id;
  if (!userId) return { issued: false };
  const id = newId('PRT');
  await db.batch(
    [
      {
        sql: `UPDATE password_reset_tokens SET status='REVOKED' WHERE user_id=? AND status='PENDING'`,
        args: [String(userId)],
      },
      {
        sql: `INSERT INTO password_reset_tokens(reset_token_id,user_id,token_hash,issued_at,expires_at,used_at,status)
            VALUES(?,?,?,?,?,NULL,'PENDING')`,
        args: [
          id,
          String(userId),
          input.tokenHash,
          toDbTimestamp(input.now),
          toDbTimestamp(input.expiresAt),
        ],
      },
      auditEventStmt({
        actorUserId: String(userId),
        eventType: 'PASSWORD_RESET_REQUESTED',
        entityType: 'users',
        entityId: String(userId),
        action: 'PASSWORD_RESET_REQUEST',
        ip: input.ip,
        userAgent: input.userAgent,
        now: input.now,
      }),
    ],
    'write',
  );
  return { issued: true, userId: String(userId) };
}

export async function completePasswordReset(
  db: Client,
  input: {
    tokenHash: string;
    passwordHash: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT reset_token_id,user_id FROM password_reset_tokens
          WHERE token_hash=? AND status='PENDING' AND used_at IS NULL AND expires_at>? LIMIT 1`,
    args: [input.tokenHash, toDbTimestamp(input.now)],
  });
  const row = result.rows[0];
  if (!row) return false;
  const userId = String(row.user_id);
  const stamp = toDbTimestamp(input.now);
  await db.batch(
    [
      {
        sql: `UPDATE password_reset_tokens SET status='USED',used_at=? WHERE reset_token_id=? AND status='PENDING'`,
        args: [stamp, String(row.reset_token_id)],
      },
      {
        sql: `UPDATE auth_credentials SET password_hash=?,password_algorithm='PBKDF2',must_change_password=0,password_changed_at=?,failed_attempts=0,locked_until=NULL,updated_at=? WHERE user_id=?`,
        args: [input.passwordHash, stamp, stamp, userId],
      },
      {
        sql: `UPDATE auth_sessions SET status='REVOKED',revoked_at=? WHERE user_id=? AND status='ACTIVE'`,
        args: [stamp, userId],
      },
      auditEventStmt({
        actorUserId: userId,
        eventType: 'PASSWORD_RESET_COMPLETED',
        entityType: 'users',
        entityId: userId,
        action: 'PASSWORD_RESET',
        ip: input.ip,
        userAgent: input.userAgent,
        now: input.now,
      }),
    ],
    'write',
  );
  return true;
}

/** A verified identity may request review; it may never adopt an account by email. */
export class RegistrationConflictError extends Error {
  constructor() {
    super('registration_identity_conflict');
  }
}

export async function createCustomerAccessRequest(
  db: Client,
  input: {
    email: string;
    provider: 'GOOGLE' | 'MICROSOFT';
    providerSubject: string;
    providerIssuer: string;
    providerTenantId: string | null;
    identityVerifiedAt: Date;
    companyName: string;
    contactName: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<string> {
  const email = normalizeIdentityEmail(input.email);
  const verifiedAt = input.identityVerifiedAt.getTime();
  if (
    !email ||
    classifyIdentityEmail(email) !== 'CORPORATE' ||
    !isRegistrationIssuer(input.provider, input.providerIssuer) ||
    !input.providerSubject?.trim() ||
    input.providerSubject.length > 255 ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > input.now.getTime() ||
    input.now.getTime() - verifiedAt >= 10 * 60_000
  )
    throw new RegistrationConflictError();
  const companyName = input.companyName.trim().slice(0, 160);
  const contactName = input.contactName.trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!companyName || !contactName) throw new RegistrationConflictError();
  const stamp = toDbTimestamp(input.now);
  const verificationStamp = toDbTimestamp(input.identityVerifiedAt);

  // A write transaction serializes identity/email checks and request creation.
  // A retry cannot race into duplicate users, provider links or pending requests.
  const tx = await db.transaction('write');
  try {
    const linked = await tx.execute({
      sql: `SELECT f.federated_identity_id, f.status AS identity_status, f.revoked_at,
                   u.user_id, u.user_type, u.status AS user_status, u.email
            FROM auth_federated_identities f JOIN users u ON u.user_id=f.user_id
            WHERE f.provider=? AND f.issuer=? AND f.provider_subject=? LIMIT 1`,
      args: [input.provider, input.providerIssuer, input.providerSubject],
    });
    const identity = linked.rows[0];
    let userId: string;
    let federatedIdentityId: string;
    if (identity) {
      if (
        identity.identity_status !== 'ACTIVE' ||
        identity.revoked_at !== null ||
        identity.user_type !== 'EXTERNAL' ||
        !['INVITED', 'ACTIVE'].includes(String(identity.user_status)) ||
        String(identity.email).toLowerCase() !== email
      )
        throw new RegistrationConflictError();
      userId = String(identity.user_id);
      federatedIdentityId = String(identity.federated_identity_id);
    } else {
      // An existing email is never enough authority to link, activate, or
      // repurpose a preprovisioned user (including an INTERNAL employee).
      const existing = await tx.execute({
        sql: 'SELECT user_id FROM users WHERE email=? LIMIT 1',
        args: [email],
      });
      if (existing.rows.length) throw new RegistrationConflictError();
      userId = newId('USR');
      federatedIdentityId = newId('FID');
      const [firstName, ...lastName] = contactName.split(' ');
      await tx.execute({
        sql: `INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,
                               status,email_verified_at,created_at,updated_at)
              VALUES(?,'EXTERNAL',?,?,?,?, 'INVITED',?,?,?)`,
        args: [
          userId,
          firstName,
          lastName.join(' '),
          contactName,
          email,
          verificationStamp,
          stamp,
          stamp,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO auth_federated_identities(
                federated_identity_id,user_id,provider,issuer,provider_subject,
                provider_tenant_id,provider_email,provider_email_verified,status,
                linked_at,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,1,'ACTIVE',?,?,?)`,
        args: [
          federatedIdentityId,
          userId,
          input.provider,
          input.providerIssuer,
          input.providerSubject,
          input.providerTenantId,
          email,
          stamp,
          stamp,
          stamp,
        ],
      });
    }
    const existingRequest = await tx.execute({
      sql: `SELECT access_request_id FROM customer_access_requests
            WHERE user_id=? AND status='PENDING'
            ORDER BY submitted_at,access_request_id LIMIT 1`,
      args: [userId],
    });
    if (existingRequest.rows[0]) {
      await tx.commit();
      return String(existingRequest.rows[0].access_request_id);
    }
    const requestId = newId('CAR');
    await tx.execute({
      sql: `INSERT INTO customer_access_requests(
              access_request_id,user_id,identity_method,federated_identity_id,
              email_at_request,email_domain,company_name,status,submitted_at,
              identity_verified_at,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,'PENDING',?,?,?,?)`,
      args: [
        requestId,
        userId,
        input.provider,
        federatedIdentityId,
        email,
        emailDomain(email),
        companyName,
        stamp,
        verificationStamp,
        stamp,
        stamp,
      ],
    });
    await tx.execute(
      auditEventStmt({
        actorUserId: userId,
        eventType: 'CUSTOMER_REGISTRATION_REQUESTED',
        entityType: 'customer_access_requests',
        entityId: requestId,
        action: 'CREATE',
        afterJson: JSON.stringify({
          domain: emailDomain(email),
          provider: input.provider,
          companyName,
          contactName,
        }),
        ip: input.ip,
        userAgent: input.userAgent,
        now: input.now,
      }),
    );
    await tx.commit();
    return requestId;
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

export async function resolveFederatedUser(
  db: Client,
  input: {
    provider: IdentityProvider;
    subject: string;
    email: string;
    emailVerified: boolean;
    tenantId: string | null;
    now: Date;
  },
) {
  const linked = await db.execute({
    sql: `SELECT f.user_id,u.user_type,u.status,u.email_verified_at FROM auth_federated_identities f JOIN users u ON u.user_id=f.user_id WHERE f.provider=? AND f.provider_subject=? LIMIT 1`,
    args: [input.provider, input.subject],
  });
  if (linked.rows[0]) {
    const row = linked.rows[0];
    if (String(row.status) !== 'ACTIVE' || !row.email_verified_at)
      return { kind: 'ineligible' as const };
    await db.execute({
      sql: `UPDATE auth_federated_identities SET provider_email=?,provider_email_verified=?,provider_tenant_id=?,last_login_at=?,updated_at=? WHERE provider=? AND provider_subject=?`,
      args: [
        input.email,
        input.emailVerified ? 1 : 0,
        input.tenantId,
        toDbTimestamp(input.now),
        toDbTimestamp(input.now),
        input.provider,
        input.subject,
      ],
    });
    return { kind: 'user' as const, userId: String(row.user_id), userType: String(row.user_type) };
  }
  if (!input.emailVerified) return { kind: 'unverified' as const };
  const matching = await db.execute({
    sql: `SELECT user_id,user_type,status,email_verified_at FROM users WHERE email=? LIMIT 1`,
    args: [input.email],
  });
  const row = matching.rows[0];
  if (!row) return { kind: 'unknown' as const };
  if (String(row.status) !== 'ACTIVE' || !row.email_verified_at)
    return { kind: 'ineligible' as const };
  if (input.provider === 'APPLE') {
    if (String(row.user_type) !== 'EXTERNAL') return { kind: 'link_required' as const };
    const membership = await db.execute({
      sql: `SELECT 1 FROM customer_portal_memberships WHERE user_id=? AND status='ACTIVE' LIMIT 1`,
      args: [String(row.user_id)],
    });
    if (!membership.rows[0]) return { kind: 'link_required' as const };
  }
  const identityId = newId('FID');
  await db.batch(
    [
      {
        sql: `INSERT INTO auth_federated_identities(identity_id,user_id,provider,provider_subject,provider_email,provider_email_verified,provider_tenant_id,linked_at,last_login_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          identityId,
          String(row.user_id),
          input.provider,
          input.subject,
          input.email,
          1,
          input.tenantId,
          toDbTimestamp(input.now),
          toDbTimestamp(input.now),
          toDbTimestamp(input.now),
          toDbTimestamp(input.now),
        ],
      },
      auditEventStmt({
        actorUserId: String(row.user_id),
        eventType: 'FEDERATED_IDENTITY_LINKED',
        entityType: 'auth_federated_identities',
        entityId: identityId,
        action: 'LINK',
        afterJson: JSON.stringify({ provider: input.provider }),
        ip: null,
        userAgent: null,
        now: input.now,
      }),
    ],
    'write',
  );
  return { kind: 'user' as const, userId: String(row.user_id), userType: String(row.user_type) };
}
