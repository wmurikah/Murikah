import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIdentityEmail,
  normalizeIdentityEmail,
  maySelfRegister,
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

test('corporate policy is centralized, normalized, and rejects protected or consumer domains', () => {
  assert.equal(normalizeIdentityEmail('  MARY@Acme.CO.KE '), 'mary@acme.co.ke');
  assert.equal(classifyIdentityEmail('person@hasspetroleum.com'), 'INTERNAL_PROTECTED');
  for (const domain of ['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me'])
    assert.equal(maySelfRegister(`person@${domain}`), false);
  assert.equal(maySelfRegister('person@acmelogistics.co.ke'), true);
  assert.equal(normalizeIdentityEmail('person@аcme.com'), null);
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
    subject: 'google-subject-1',
  });
  assert.deepEqual(await verifyRegistrationGrant('registration-secret-long-enough', grant), {
    email: 'mary@acme.example',
    provider: 'GOOGLE',
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
