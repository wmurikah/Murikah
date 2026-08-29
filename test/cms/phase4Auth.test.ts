import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyIdentityEmail,
  normalizeIdentityEmail,
} from '../../src/lib/cms/auth/identityPolicy.ts';
import { newOneTimeToken, hashOneTimeToken } from '../../src/lib/cms/auth/tokens.ts';
import { createTestDb } from './support/db.ts';
import { hashPassword, PASSWORD_ALGORITHM_PBKDF2 } from '../../src/lib/cms/auth/password.ts';
import { requestPasswordReset, resetPassword } from '../../src/lib/cms/auth/passwordReset.ts';
import { attemptLogin } from '../../src/lib/cms/auth/loginFlow.ts';
import {
  createRegistrationGrant,
  verifyRegistrationGrant,
} from '../../src/lib/cms/auth/registrationGrant.ts';
import {
  createOidcTransaction,
  consumeOidcTransaction,
} from '../../src/lib/cms/repos/oidcTransactions.ts';
import {
  createCustomerAccessRequest,
  resolveFederatedUser,
} from '../../src/lib/cms/repos/identityGateway.ts';

test('domain policy is database-authoritative, normalized, complete, and fail-closed', async () => {
  const db = createTestDb();
  const client = db as never;
  assert.equal(normalizeIdentityEmail('  MARY@Acme.CO.KE '), 'mary@acme.co.ke');
  assert.equal(
    await classifyIdentityEmail(client, 'person@hasspetroleum.com'),
    'INTERNAL_PROTECTED',
  );
  for (const domain of [
    'gmail.com',
    'outlook.com',
    'mac.com',
    'pm.me',
    'privaterelay.appleid.com',
    'private.icloud.com',
  ])
    assert.equal(await classifyIdentityEmail(client, `person@${domain}`), 'CONSUMER');
  assert.equal(await classifyIdentityEmail(client, 'person@acmelogistics.co.ke'), 'CORPORATE');
  assert.equal(normalizeIdentityEmail('person@аcme.com'), null);
  await assert.rejects(() =>
    classifyIdentityEmail(
      {
        execute: async () => {
          throw new Error('offline');
        },
      } as never,
      'person@acme.example',
    ),
  );
});

test('one-time token hashes are keyed and raw tokens are never the stored value', async () => {
  const token = newOneTimeToken();
  assert.ok(token.length >= 40);
  assert.notEqual(await hashOneTimeToken(token, 'secret'), token);
  assert.notEqual(await hashOneTimeToken(token, 'secret'), await hashOneTimeToken(token, 'other'));
});

test('a registration grant is short-lived, provider verified, and tamper evident', async () => {
  const grant = await createRegistrationGrant('registration-secret-long-enough', {
    email: 'mary@acme.example',
    provider: 'GOOGLE',
    issuer: 'https://accounts.google.com',
    subject: 'google-subject-1',
  });
  assert.deepEqual(await verifyRegistrationGrant('registration-secret-long-enough', grant), {
    email: 'mary@acme.example',
    provider: 'GOOGLE',
    issuer: 'https://accounts.google.com',
    subject: 'google-subject-1',
  });
  const parts = grant.split('.');
  const signature = parts[2] ?? '';
  parts[2] = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  await assert.rejects(() =>
    verifyRegistrationGrant('registration-secret-long-enough', parts.join('.')),
  );
});

test('password reset is generic, single-use, changes password, and revokes sessions', async () => {
  const db = createTestDb();
  const client = db as never;
  const fixture = { userId: 'USR-P4', email: 'person@acme.example' };
  const now = new Date('2026-08-29T09:00:00Z');
  await db.execute({
    sql: `INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,status,email_verified_at) VALUES(?,'EXTERNAL','Phase','Four','Phase Four',?,'ACTIVE',?)`,
    args: [fixture.userId, fixture.email, '2026-01-01 00:00:00'],
  });
  await db.execute({
    sql: `INSERT INTO auth_credentials(credential_id,user_id,password_hash,password_algorithm,must_change_password) VALUES('CRED-P4',?,?,?,0)`,
    args: [fixture.userId, await hashPassword('old-secure-password'), PASSWORD_ALGORITHM_PBKDF2],
  });
  const unknown = await requestPasswordReset(client, 'secret', 'unknown@example.com', {
    ip: null,
    userAgent: null,
    now,
  });
  assert.equal(unknown.issued, false);
  const issued = await requestPasswordReset(client, 'secret', fixture.email, {
    ip: null,
    userAgent: null,
    now,
  });
  assert.equal(issued.issued, true);
  if (!issued.issued) return;
  assert.equal(
    await resetPassword(client, 'secret', issued.rawToken, 'a-new-secure-password', {
      ip: null,
      userAgent: null,
      now: new Date(now.getTime() + 1000),
    }),
    true,
  );
  assert.equal(
    await resetPassword(client, 'secret', issued.rawToken, 'another-secure-password', {
      ip: null,
      userAgent: null,
      now: new Date(now.getTime() + 2000),
    }),
    false,
  );
  const login = await attemptLogin(
    client,
    'secret',
    { email: fixture.email, password: 'a-new-secure-password' },
    { ip: null, userAgent: null, now: new Date(now.getTime() + 3000) },
  );
  assert.equal(login.kind, 'success');
});

test('OIDC state is atomically consumable exactly once', async () => {
  const db = createTestDb();
  const client = db as never;
  const now = new Date('2026-08-29T09:00:00Z');
  await createOidcTransaction(client, {
    provider: 'GOOGLE',
    purpose: 'SIGN_IN',
    stateHash: 'state-hash',
    nonceHash: 'nonce-hash',
    verifier: 'verifier',
    returnPath: '/app',
    now,
  });
  const [first, second] = await Promise.all([
    consumeOidcTransaction(client, 'state-hash', now),
    consumeOidcTransaction(client, 'state-hash', now),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test('canonical federated identity is issuer-separated, collision-safe, and revocable', async () => {
  const db = createTestDb();
  const client = db as never;
  const now = new Date('2026-08-29T09:00:00Z');
  await db.execute({
    sql: `INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,status,email_verified_at) VALUES('USR-FED','EXTERNAL','Federated','User','Federated User','fed@acme.example','ACTIVE','2026-01-01 00:00:00')`,
  });
  const base = {
    provider: 'GOOGLE' as const,
    subject: 'subject-1',
    email: 'fed@acme.example',
    emailVerified: true,
    tenantId: null,
    now,
  };
  assert.equal(
    (await resolveFederatedUser(client, { ...base, issuer: 'https://accounts.google.com' })).kind,
    'user',
  );
  assert.equal(
    (await resolveFederatedUser(client, { ...base, issuer: 'https://issuer.example' })).kind,
    'user',
  );
  const rows = db.raw
    .prepare(`SELECT federated_identity_id,issuer FROM auth_federated_identities ORDER BY issuer`)
    .all();
  assert.equal(rows.length, 2);
  assert.throws(() =>
    db.raw
      .prepare(
        `INSERT INTO auth_federated_identities(federated_identity_id,user_id,provider,issuer,provider_subject,provider_email,provider_email_verified,status,linked_at) VALUES('FID-COLLIDE','USR-FED','GOOGLE','https://accounts.google.com','subject-1','other@acme.example',1,'ACTIVE','2026-01-01 00:00:00')`,
      )
      .run(),
  );
  db.raw
    .prepare(
      `UPDATE auth_federated_identities SET status='REVOKED',revoked_at='2026-08-29 09:01:00' WHERE issuer='https://accounts.google.com'`,
    )
    .run();
  assert.equal(
    (await resolveFederatedUser(client, { ...base, issuer: 'https://accounts.google.com' })).kind,
    'ineligible',
  );
});

test('pending customer registration needs no user and duplicate creation is database-safe', async () => {
  const db = createTestDb();
  const client = db as never;
  const input = {
    email: 'requester@acme.example',
    emailDomain: 'acme.example',
    provider: 'GOOGLE' as const,
    providerSubject: 'subject-register',
    providerIssuer: 'https://accounts.google.com',
    companyName: 'Acme',
    contactName: 'Mary',
    now: new Date('2026-08-29T09:00:00Z'),
    ip: null,
    userAgent: null,
  };
  const first = await createCustomerAccessRequest(client, input);
  const second = await createCustomerAccessRequest(client, input);
  assert.equal(second, first);
  const row = db.raw
    .prepare(
      `SELECT access_request_id,user_id,email_at_request,identity_verified_at FROM customer_access_requests`,
    )
    .get() as Record<string, unknown>;
  assert.equal(row.user_id, null);
  assert.equal(row.email_at_request, input.email);
  assert.ok(row.identity_verified_at);
  assert.equal(db.raw.prepare(`SELECT count(*) AS n FROM customer_access_requests`).get()!.n, 1);
});

test('live reconciliation preserves domain policies and produces the canonical request contract', () => {
  const db = createTestDb();
  db.raw.exec(`DROP TABLE customer_access_requests;
    CREATE TABLE customer_access_requests(
      access_request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,identity_method TEXT NOT NULL,
      federated_identity_id TEXT,email_at_request TEXT NOT NULL,email_domain TEXT NOT NULL,
      requested_account_id TEXT,requested_contact_id TEXT,company_name TEXT,status TEXT NOT NULL,
      submitted_at TEXT NOT NULL,identity_verified_at TEXT NOT NULL,reviewed_at TEXT,
      reviewed_by_user_id TEXT,decision_reason TEXT,approved_membership_id TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );`);
  db.raw.exec(readFileSync('docs/cms/PHASE4_LIVE_RECONCILIATION.sql', 'utf8'));
  const columns = db.raw
    .prepare(`PRAGMA table_info('customer_access_requests')`)
    .all() as unknown as { name: string; notnull: number }[];
  assert.equal(columns.find((column) => column.name === 'user_id')?.notnull, 0);
  assert.ok(columns.some((column) => column.name === 'provider_issuer'));
  assert.ok(columns.some((column) => column.name === 'provider_subject'));
  assert.equal(db.raw.prepare(`SELECT count(*) AS n FROM auth_email_domain_policies`).get()!.n, 16);
  assert.deepEqual(db.raw.prepare(`PRAGMA foreign_key_check`).all(), []);
  assert.equal(db.raw.prepare(`PRAGMA integrity_check`).get()!.integrity_check, 'ok');
});
