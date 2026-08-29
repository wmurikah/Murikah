import type { Client } from '@libsql/client/web';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
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

export async function createCustomerAccessRequest(
  db: Client,
  input: {
    email: string;
    emailDomain: string;
    provider: 'PASSWORD' | 'GOOGLE' | 'MICROSOFT';
    providerSubject?: string | null;
    companyName: string;
    contactName: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<string> {
  const existing = await db.execute({
    sql: `SELECT request_id FROM customer_access_requests WHERE email=? AND status='PENDING' LIMIT 1`,
    args: [input.email],
  });
  if (existing.rows[0]) return String(existing.rows[0].request_id);
  const requestId = newId('CAR');
  await db.batch(
    [
      {
        sql: `INSERT INTO customer_access_requests(request_id,user_id,email,email_domain,provider,provider_subject,requested_account_id,company_name,contact_name,status,submitted_at,created_at,updated_at)
            VALUES(?,NULL,?,?,?,?,NULL,?,?,'PENDING',?,?,?)`,
        args: [
          requestId,
          input.email,
          input.emailDomain,
          input.provider,
          input.providerSubject ?? null,
          input.companyName,
          input.contactName,
          toDbTimestamp(input.now),
          toDbTimestamp(input.now),
          toDbTimestamp(input.now),
        ],
      },
      auditEventStmt({
        actorUserId: null,
        eventType: 'CUSTOMER_REGISTRATION_REQUESTED',
        entityType: 'customer_access_requests',
        entityId: requestId,
        action: 'CREATE',
        afterJson: JSON.stringify({ domain: input.emailDomain, provider: input.provider }),
        ip: input.ip,
        userAgent: input.userAgent,
        now: input.now,
      }),
    ],
    'write',
  );
  return requestId;
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
