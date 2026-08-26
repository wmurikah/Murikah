/**
 * The authentication flow, against a real database.
 *
 * An isolated in-memory SQLite built from the operator's own DDL, constraints
 * included, so these assertions are about what the code does rather than what
 * it intends. Nothing here points at hass-cms.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seed, IDS, EMAILS, FIXTURE_PASSWORD, WRONG_PASSWORD } from './support/seed.ts';
import {
  attemptLogin,
  resolveSession,
  endSession,
  LOCKOUT_THRESHOLD,
  LOCKOUT_MINUTES,
} from '../../src/lib/cms/auth/loginFlow.ts';
import { hashSessionToken, toDbTimestamp } from '../../src/lib/cms/auth/session.ts';
import { upsertCredential } from '../../src/lib/cms/repos/authRecords.ts';
import { hashPassword, PASSWORD_ALGORITHM_PBKDF2 } from '../../src/lib/cms/auth/password.ts';

const SECRET = 'test-only-session-secret';
const NOW = new Date('2026-08-26T09:00:00Z');
const CTX = { ip: '10.0.0.10', userAgent: 'HassCMS Test', now: NOW };

const db = async (): Promise<TestClient> => {
  const client = createTestDb();
  await seed(client);
  return client;
};
// The flow takes the libSQL Client interface; the adapter implements the slice
// this product uses. One cast at the boundary rather than a cast per call.
const asClient = (c: TestClient) => c as unknown as Parameters<typeof attemptLogin>[0];

const login = (c: TestClient, email: string, password: string, now = NOW) =>
  attemptLogin(asClient(c), SECRET, { email, password }, { ...CTX, now });

test('a valid sign-in succeeds, creates a session and records the attempt', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  assert.equal(outcome.kind, 'success');
  if (outcome.kind !== 'success') return;

  assert.equal(outcome.identity.userId, IDS.active);
  assert.equal(outcome.identity.email, EMAILS.active);
  assert.equal(outcome.identity.userType, 'INTERNAL');

  const sessions = query(c, `SELECT * FROM auth_sessions WHERE user_id = ?`, IDS.active);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.status, 'ACTIVE');
  assert.ok(String(sessions[0]?.expires_at) >= String(sessions[0]?.issued_at));

  // last_login_at was stamped, and the attempt was recorded as a success.
  const user = query(c, `SELECT last_login_at FROM users WHERE user_id = ?`, IDS.active)[0];
  assert.equal(user?.last_login_at, toDbTimestamp(NOW));
  const attempts = query(c, `SELECT * FROM login_attempts WHERE success = 1`);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.user_id, IDS.active);
  c.close();
});

test('the stored session hash is not the cookie, and is keyed with the secret', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  assert.equal(outcome.kind, 'success');
  if (outcome.kind !== 'success') return;

  const stored = String(
    query(c, `SELECT refresh_token_hash FROM auth_sessions`)[0]?.refresh_token_hash,
  );
  assert.notEqual(stored, outcome.rawToken);
  assert.equal(stored, await hashSessionToken(outcome.rawToken, SECRET));
  assert.notEqual(stored, await hashSessionToken(outcome.rawToken, 'a different secret'));
  c.close();
});

test('a wrong password fails and records the internal reason', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, WRONG_PASSWORD);
  assert.deepEqual(outcome, { kind: 'failure', reason: 'INVALID_PASSWORD' });
  assert.equal(query(c, `SELECT * FROM auth_sessions`).length, 0);
  const attempt = query(c, `SELECT * FROM login_attempts`)[0];
  assert.equal(attempt?.success, 0);
  assert.equal(attempt?.failure_reason, 'INVALID_PASSWORD');
  c.close();
});

test('an unknown email fails, and still records an attempt', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.unknown, FIXTURE_PASSWORD);
  assert.deepEqual(outcome, { kind: 'failure', reason: 'UNKNOWN_EMAIL' });
  const attempt = query(c, `SELECT * FROM login_attempts`)[0];
  // user_id is nullable precisely so an attempt against an unknown address
  // still lands, which is what makes enumeration visible to an administrator.
  assert.equal(attempt?.user_id, null);
  assert.equal(attempt?.email_attempted, EMAILS.unknown);
  assert.equal(attempt?.failure_reason, 'UNKNOWN_EMAIL');
  c.close();
});

test('a suspended user is refused even with the correct password', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.suspended, FIXTURE_PASSWORD);
  assert.deepEqual(outcome, { kind: 'failure', reason: 'USER_NOT_ACTIVE' });
  c.close();
});

test('an inactive, unverified user is refused', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.inactive, FIXTURE_PASSWORD);
  assert.deepEqual(outcome, { kind: 'failure', reason: 'USER_NOT_ACTIVE' });
  c.close();
});

test('an active user with no credential row is refused', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.noCredential, FIXTURE_PASSWORD);
  assert.deepEqual(outcome, { kind: 'failure', reason: 'NO_CREDENTIAL' });
  c.close();
});

test('a seeded DEMO_DISABLED credential cannot sign in', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.legacyAlgorithm, FIXTURE_PASSWORD);
  assert.deepEqual(outcome, { kind: 'failure', reason: 'UNSUPPORTED_ALGORITHM' });
  c.close();
});

test('the lockout threshold locks the account, and a correct password is then refused', async () => {
  const c = await db();
  for (let i = 1; i <= LOCKOUT_THRESHOLD; i++) {
    const outcome = await login(c, EMAILS.active, WRONG_PASSWORD);
    assert.equal(outcome.kind, 'failure');
    const cred = query(
      c,
      `SELECT failed_attempts, locked_until FROM auth_credentials WHERE user_id = ?`,
      IDS.active,
    )[0];
    assert.equal(cred?.failed_attempts, i);
    if (i < LOCKOUT_THRESHOLD) assert.equal(cred?.locked_until, null, `locked early at ${i}`);
    else assert.notEqual(cred?.locked_until, null, 'must lock at the threshold');
  }
  // The correct password is now refused, and refused as LOCKED rather than as
  // a bad password, so the audit trail says what really happened.
  const locked = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  assert.deepEqual(locked, { kind: 'failure', reason: 'ACCOUNT_LOCKED' });
  assert.equal(query(c, `SELECT * FROM auth_sessions`).length, 0);
  c.close();
});

test('once the lock expires the correct password works again, and the counter resets', async () => {
  const c = await db();
  for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await login(c, EMAILS.active, WRONG_PASSWORD);
  const later = new Date(NOW.getTime() + (LOCKOUT_MINUTES + 1) * 60_000);
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD, later);
  assert.equal(outcome.kind, 'success');
  const cred = query(
    c,
    `SELECT failed_attempts, locked_until FROM auth_credentials WHERE user_id = ?`,
    IDS.active,
  )[0];
  assert.equal(cred?.failed_attempts, 0);
  assert.equal(cred?.locked_until, null);
  c.close();
});

test('/me resolves the identity, roles, scopes and permissions for a session', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');

  const resolved = await resolveSession(asClient(c), SECRET, outcome.rawToken, NOW);
  assert.equal(resolved.kind, 'authenticated');
  if (resolved.kind !== 'authenticated') return;
  const id = resolved.identity;

  assert.equal(id.displayName, `Test ${IDS.active}`);
  assert.deepEqual(id.roles.map((r) => r.roleId).sort(), ['ROLE-ADMIN', 'ROLE-CSM']);
  // ROLE-PORTAL is assigned but its effective_to has passed, so it must not appear.
  assert.ok(!id.roles.some((r) => r.roleId === 'ROLE-PORTAL'));

  // The union of grants across both live roles. SERVICE.CASES.VIEW is present
  // because ROLE-CSM grants it, even though ROLE-CSM's sibling ROLE-ADMIN
  // carries an allowed = 0 row for the same permission. See the semantics test
  // below: permissions are additive, and a denial in one role does not veto a
  // grant in another.
  assert.deepEqual(id.permissions.sort(), [
    'ADMIN.ROLES.MANAGE',
    'ADMIN.USERS.MANAGE',
    'AUDIT.EVENTS.VIEW',
    'SERVICE.CASES.CREATE',
    'SERVICE.CASES.VIEW',
  ]);

  assert.equal(id.assignment?.level, 'AFFILIATE');
  assert.equal(id.assignment?.jobTitle, 'Customer Service Manager');
  assert.equal(id.assignment?.department, 'Customer Service');
  assert.equal(id.assignment?.affiliateName, 'Hass Kenya');
  assert.deepEqual(id.scopes, [
    {
      roleId: 'ROLE-CSM',
      scopeType: 'COUNTRY',
      countryId: 'CTR-KE',
      affiliateId: null,
      businessUnitId: null,
      teamId: null,
    },
  ]);
  c.close();
});

test('permissions are additive across roles, and allowed = 0 grants nothing on its own', async () => {
  // The semantics, made explicit because they are a decision rather than an
  // accident, and because a reader could reasonably assume the opposite.
  //
  // Build Prompt 03 specifies the join "through role_permissions where
  // allowed = 1", which is the additive reading: a role grants what its
  // allowed = 1 rows say, and the user holds the union across their live roles.
  // An allowed = 0 row therefore means "this role does not grant this", not
  // "nobody may have this", so it cannot veto a grant that arrives from a
  // second role.
  //
  // The alternative, deny-overrides-grant, is the safer-sounding reading and is
  // deliberately NOT implemented: with it, adding a role to a user could remove
  // access they already had, which is a surprising and hard-to-debug property.
  // The operator's seed carries zero allowed = 0 rows today, so nothing in the
  // live data depends on the choice; if deny-override is ever wanted, this test
  // is the place it changes.
  const c = await db();

  // ROLE-ADMIN denies SERVICE.CASES.VIEW; ROLE-CSM grants it.
  const denial = query(
    c,
    `SELECT allowed FROM role_permissions WHERE role_id = 'ROLE-ADMIN' AND permission_id = 'PERM-3'`,
  )[0];
  assert.equal(denial?.allowed, 0);

  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');
  assert.ok(outcome.identity.permissions.includes('SERVICE.CASES.VIEW'));

  // With the granting role gone, the denial is all that is left and the
  // permission disappears, which proves the allowed = 0 row is being read
  // rather than ignored.
  await c.execute({
    sql: `UPDATE user_roles SET active = 0 WHERE user_role_id = 'UR-2'`,
    args: [],
  });
  const after = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (after.kind !== 'success') return assert.fail('login failed');
  assert.ok(!after.identity.permissions.includes('SERVICE.CASES.VIEW'));
  c.close();
});

test('an EXTERNAL user resolves their portal account scope', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.external, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');
  const resolved = await resolveSession(asClient(c), SECRET, outcome.rawToken, NOW);
  if (resolved.kind !== 'authenticated') return assert.fail('not authenticated');
  assert.equal(resolved.identity.userType, 'EXTERNAL');
  assert.deepEqual(resolved.identity.portalMemberships, [
    {
      accountId: 'ACC-1',
      accountName: 'Kenya Transporters Ltd',
      portalRoleId: 'ROLE-PORTAL',
      status: 'ACTIVE',
    },
  ]);
  c.close();
});

test('/me without a session is anonymous', async () => {
  const c = await db();
  assert.deepEqual(await resolveSession(asClient(c), SECRET, null, NOW), { kind: 'anonymous' });
  assert.deepEqual(await resolveSession(asClient(c), SECRET, 'not-a-real-token', NOW), {
    kind: 'anonymous',
  });
  c.close();
});

test('a session presented with the wrong secret does not resolve', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');
  const resolved = await resolveSession(asClient(c), 'the wrong secret', outcome.rawToken, NOW);
  assert.deepEqual(resolved, { kind: 'anonymous' });
  c.close();
});

test('logout revokes the session and the same cookie is then rejected', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');

  assert.deepEqual(await endSession(asClient(c), SECRET, outcome.rawToken, CTX), { revoked: true });
  const row = query(c, `SELECT status, revoked_at FROM auth_sessions`)[0];
  assert.equal(row?.status, 'REVOKED');
  assert.equal(row?.revoked_at, toDbTimestamp(NOW));

  assert.deepEqual(await resolveSession(asClient(c), SECRET, outcome.rawToken, NOW), {
    kind: 'anonymous',
  });
  // Revoking again is a no-op rather than an error.
  assert.deepEqual(await endSession(asClient(c), SECRET, outcome.rawToken, CTX), {
    revoked: false,
  });
  c.close();
});

test('an expired session is marked EXPIRED on the way past and rejected', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');

  const later = new Date(NOW.getTime() + 9 * 60 * 60 * 1000); // past the 8h TTL
  assert.deepEqual(await resolveSession(asClient(c), SECRET, outcome.rawToken, later), {
    kind: 'anonymous',
  });
  assert.equal(query(c, `SELECT status FROM auth_sessions`)[0]?.status, 'EXPIRED');
  c.close();
});

test('every attempt lands in login_attempts, success and failure alike', async () => {
  const c = await db();
  await login(c, EMAILS.unknown, WRONG_PASSWORD);
  await login(c, EMAILS.active, WRONG_PASSWORD);
  await login(c, EMAILS.active, FIXTURE_PASSWORD);
  const attempts = query(
    c,
    `SELECT success, failure_reason, ip_address, user_agent FROM login_attempts ORDER BY login_attempt_id`,
  );
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter((a) => a.success === 1).length, 1);
  assert.equal(attempts.filter((a) => a.success === 0).length, 2);
  for (const a of attempts) {
    assert.equal(a.ip_address, '10.0.0.10');
    assert.equal(a.user_agent, 'HassCMS Test');
  }
  c.close();
});

test('audit_events gains the expected rows and never holds a secret', async () => {
  const c = await db();
  await login(c, EMAILS.active, WRONG_PASSWORD);
  const ok = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (ok.kind !== 'success') return assert.fail('login failed');
  await endSession(asClient(c), SECRET, ok.rawToken, CTX);

  const events = query(
    c,
    `SELECT event_type, before_json, after_json FROM audit_events ORDER BY audit_event_id`,
  );
  const types = events.map((e) => e.event_type).sort();
  assert.deepEqual(types, ['LOGIN_FAILED', 'LOGIN_SUCCESS', 'LOGOUT']);

  const blob = JSON.stringify(events);
  for (const forbidden of [
    FIXTURE_PASSWORD,
    WRONG_PASSWORD,
    SECRET,
    ok.rawToken,
    'pbkdf2-sha256',
  ]) {
    assert.ok(!blob.includes(forbidden), `audit_events must not contain ${forbidden.slice(0, 12)}`);
  }
  c.close();
});

test('no identity returned to a caller carries a hash, token or secret', async () => {
  const c = await db();
  const outcome = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (outcome.kind !== 'success') return assert.fail('login failed');
  const resolved = await resolveSession(asClient(c), SECRET, outcome.rawToken, NOW);
  if (resolved.kind !== 'authenticated') return assert.fail('not authenticated');

  const body = JSON.stringify(resolved.identity);
  for (const forbidden of [
    'password_hash',
    'refresh_token_hash',
    'secret_encrypted',
    'token_hash',
    'pbkdf2-sha256',
    FIXTURE_PASSWORD,
  ]) {
    assert.ok(!body.includes(forbidden), `identity must not contain ${forbidden}`);
  }
  c.close();
});

test('the bootstrap upsert replaces a disabled credential and clears the lock', async () => {
  const c = await db();
  // Lock the legacy account first, so the reset is visible.
  await c.execute({
    sql: `UPDATE auth_credentials SET failed_attempts = 4, locked_until = '2099-01-01 00:00:00' WHERE user_id = ?`,
    args: [IDS.legacyAlgorithm],
  });

  const stored = await hashPassword(FIXTURE_PASSWORD);
  const action = await upsertCredential(asClient(c), {
    userId: IDS.legacyAlgorithm,
    passwordHash: stored,
    algorithm: PASSWORD_ALGORITHM_PBKDF2,
    mustChangePassword: false,
    now: NOW,
  });
  assert.equal(action, 'updated');

  const cred = query(
    c,
    `SELECT password_algorithm, failed_attempts, locked_until, password_changed_at FROM auth_credentials WHERE user_id = ?`,
    IDS.legacyAlgorithm,
  )[0];
  assert.equal(cred?.password_algorithm, 'PBKDF2');
  assert.equal(cred?.failed_attempts, 0);
  assert.equal(cred?.locked_until, null);
  assert.equal(cred?.password_changed_at, toDbTimestamp(NOW));

  // And the account can now sign in, which is the point of the command.
  assert.equal((await login(c, EMAILS.legacyAlgorithm, FIXTURE_PASSWORD)).kind, 'success');
  c.close();
});

test('the bootstrap inserts when a user has no credential row at all', async () => {
  const c = await db();
  const action = await upsertCredential(asClient(c), {
    userId: IDS.noCredential,
    passwordHash: await hashPassword(FIXTURE_PASSWORD),
    algorithm: PASSWORD_ALGORITHM_PBKDF2,
    mustChangePassword: true,
    now: NOW,
  });
  assert.equal(action, 'inserted');
  assert.equal(
    query(c, `SELECT COUNT(*) c FROM auth_credentials WHERE user_id = ?`, IDS.noCredential)[0]?.c,
    1,
  );
  c.close();
});

test('foreign keys hold after the whole flow', async () => {
  const c = await db();
  await login(c, EMAILS.unknown, WRONG_PASSWORD);
  await login(c, EMAILS.active, WRONG_PASSWORD);
  const ok = await login(c, EMAILS.active, FIXTURE_PASSWORD);
  if (ok.kind === 'success') await endSession(asClient(c), SECRET, ok.rawToken, CTX);
  assert.deepEqual(query(c, `PRAGMA foreign_key_check`), []);
  c.close();
});
