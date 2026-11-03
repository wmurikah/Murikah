import type { Client } from '@libsql/client/web';
import { newId, auditEventStmt, createSessionStmt, touchLastLoginStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import {
  normalizeIdentityEmail,
  classifyIdentityEmail,
  emailDomain,
  isRegistrationIssuer,
  isFederatedIssuer,
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

interface FederatedIdentityInput {
  provider: IdentityProvider;
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  tenantId: string | null;
  now: Date;
}

export async function resolveFederatedUser(db: Client, input: FederatedIdentityInput) {
  // Validate before either the linked or automatic-link path. An existing link
  // must not bypass provider verification or issuer validation.
  if (input.emailVerified !== true) return { kind: 'unverified' as const };
  const email = normalizeIdentityEmail(input.email);
  if (
    !email ||
    !isFederatedIssuer(input.provider, input.issuer) ||
    typeof input.subject !== 'string' ||
    !input.subject.trim() ||
    input.subject.length > 255
  )
    return { kind: 'ineligible' as const };

  const tx = await db.transaction('write');
  try {
    const linked = await tx.execute({
      // Read revoked links too: absence of an ACTIVE link is not authority to
      // recreate a revoked identity through the email-based fallback.
      sql: `SELECT f.federated_identity_id, f.status AS identity_status, f.revoked_at,
                   u.user_id,u.user_type,u.status AS user_status,u.email_verified_at
            FROM auth_federated_identities f JOIN users u ON u.user_id=f.user_id
            WHERE f.provider=? AND f.issuer=? AND f.provider_subject=? LIMIT 1`,
      args: [input.provider, input.issuer, input.subject],
    });
    if (linked.rows[0]) {
      const row = linked.rows[0];
      if (
        row.identity_status !== 'ACTIVE' ||
        row.revoked_at !== null ||
        row.user_status !== 'ACTIVE' ||
        !row.email_verified_at
      ) {
        await tx.commit();
        return { kind: 'ineligible' as const };
      }
      await tx.execute({
        sql: `UPDATE auth_federated_identities
              SET provider_email=?,provider_email_verified=1,provider_tenant_id=?,last_login_at=?,updated_at=?
              WHERE federated_identity_id=? AND status='ACTIVE' AND revoked_at IS NULL`,
        args: [
          email,
          input.tenantId,
          toDbTimestamp(input.now),
          toDbTimestamp(input.now),
          String(row.federated_identity_id),
        ],
      });
      await tx.commit();
      return {
        kind: 'user' as const,
        userId: String(row.user_id),
        userType: String(row.user_type),
        federatedIdentityId: String(row.federated_identity_id),
      };
    }

    // Preserve the existing automatic-link policy: only provisioned, active,
    // verified exact-email users. Never create a user or move a linked subject.
    const matching = await tx.execute({
      sql: 'SELECT user_id,user_type,status,email_verified_at FROM users WHERE email=? LIMIT 1',
      args: [email],
    });
    const user = matching.rows[0];
    if (!user) {
      await tx.commit();
      return { kind: 'unknown' as const };
    }
    if (user.status !== 'ACTIVE' || !user.email_verified_at) {
      await tx.commit();
      return { kind: 'ineligible' as const };
    }
    const previous = await tx.execute({
      sql: 'SELECT federated_identity_id FROM auth_federated_identities WHERE user_id=? AND provider=? LIMIT 1',
      args: [String(user.user_id), input.provider],
    });
    if (previous.rows.length) {
      // A different issuer/subject or a revoked prior link needs explicit review,
      // rather than attaching another identity on the strength of email alone.
      await tx.commit();
      return { kind: 'link_required' as const };
    }
    if (input.provider === 'APPLE') {
      const membership =
        user.user_type === 'EXTERNAL'
          ? await tx.execute({
              sql: "SELECT 1 FROM customer_portal_memberships WHERE user_id=? AND status='ACTIVE' LIMIT 1",
              args: [String(user.user_id)],
            })
          : null;
      if (!membership?.rows.length) {
        await tx.commit();
        return { kind: 'link_required' as const };
      }
    }
    const identityId = newId('FID');
    const stamp = toDbTimestamp(input.now);
    await tx.execute({
      sql: `INSERT INTO auth_federated_identities(
              federated_identity_id,user_id,provider,issuer,provider_subject,provider_email,
              provider_email_verified,provider_tenant_id,status,linked_at,last_login_at,created_at,updated_at)
            VALUES(?,?,?,?,?,?,1,?,'ACTIVE',?,?,?,?)`,
      args: [
        identityId,
        String(user.user_id),
        input.provider,
        input.issuer,
        input.subject,
        email,
        input.tenantId,
        stamp,
        stamp,
        stamp,
        stamp,
      ],
    });
    await tx.execute(
      auditEventStmt({
        actorUserId: String(user.user_id),
        eventType: 'FEDERATED_IDENTITY_LINKED',
        entityType: 'auth_federated_identities',
        entityId: identityId,
        action: 'LINK',
        afterJson: JSON.stringify({ provider: input.provider, issuer: input.issuer }),
        ip: null,
        userAgent: null,
        now: input.now,
      }),
    );
    await tx.commit();
    return {
      kind: 'user' as const,
      userId: String(user.user_id),
      userType: String(user.user_type),
      federatedIdentityId: identityId,
    };
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

/** Recheck identity eligibility in the same write transaction that issues the session. */
export async function createFederatedSession(
  db: Client,
  input: {
    userId: string;
    federatedIdentityId: string;
    provider: IdentityProvider;
    issuer: string;
    subject: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    ip: string | null;
    userAgent: string | null;
    now: Date;
  },
): Promise<boolean> {
  const tx = await db.transaction('write');
  try {
    const eligible = await tx.execute({
      sql: `SELECT 1 FROM auth_federated_identities f JOIN users u ON u.user_id=f.user_id
            WHERE f.federated_identity_id=? AND f.user_id=? AND f.provider=? AND f.issuer=? AND f.provider_subject=?
              AND f.status='ACTIVE' AND f.revoked_at IS NULL
              AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL LIMIT 1`,
      args: [input.federatedIdentityId, input.userId, input.provider, input.issuer, input.subject],
    });
    if (!eligible.rows.length) {
      await tx.commit();
      return false;
    }
    await tx.execute(
      createSessionStmt({
        sessionId: newId('ASESS'),
        userId: input.userId,
        tokenHash: input.tokenHash,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        ip: input.ip,
        userAgent: input.userAgent,
      }),
    );
    await tx.execute(touchLastLoginStmt(input.userId, input.now));
    await tx.execute(
      auditEventStmt({
        actorUserId: input.userId,
        eventType: 'FEDERATED_LOGIN_SUCCESS',
        entityType: 'users',
        entityId: input.userId,
        action: 'LOGIN',
        afterJson: JSON.stringify({ provider: input.provider }),
        ip: input.ip,
        userAgent: input.userAgent,
        now: input.now,
      }),
    );
    await tx.commit();
    return true;
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}
