import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistrationDb } from './support/registrationDb.ts';
import {
  resolveFederatedUser,
  createFederatedSession,
} from '../../src/lib/cms/repos/identityGateway.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const GOOGLE = 'https://accounts.google.com';
const MS = 'https://login.microsoftonline.com/12345678-abcd-1234-abcd-123456789abc/v2.0';
const input = {
  provider: 'GOOGLE' as const,
  issuer: GOOGLE,
  subject: 'provider-subject',
  email: 'existing@customer.example',
  emailVerified: true,
  tenantId: null,
  now: NOW,
};
type Db = ReturnType<typeof createRegistrationDb>;
const client = (db: Db) => db as unknown as Parameters<typeof resolveFederatedUser>[0];
const count = (db: Db, table: string) =>
  Number(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
function user(db: Db, id = 'USER', email = input.email, type = 'EXTERNAL', status = 'ACTIVE') {
  db.raw
    .prepare(
      `INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,status,email_verified_at)
    VALUES(?,?,'Test','Person','Test Person',?,?,?)`,
    )
    .run(id, type, email, status, status === 'ACTIVE' ? '2026-01-01 00:00:00' : null);
}
function link(
  db: Db,
  {
    id = 'FID',
    owner = 'USER',
    provider = 'GOOGLE',
    issuer = GOOGLE,
    subject = input.subject,
    status = 'ACTIVE',
    revokedAt = null,
  }: {
    id?: string;
    owner?: string;
    provider?: string;
    issuer?: string;
    subject?: string;
    status?: string;
    revokedAt?: string | null;
  } = {},
) {
  db.raw
    .prepare(
      `INSERT INTO auth_federated_identities(federated_identity_id,user_id,provider,issuer,provider_subject,status,revoked_at)
    VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, owner, provider, issuer, subject, status, revokedAt);
}
function sessionInput(identityId = 'FID') {
  return {
    userId: 'USER',
    federatedIdentityId: identityId,
    provider: 'GOOGLE' as const,
    issuer: GOOGLE,
    subject: input.subject,
    tokenHash: 'hashed-session-token',
    issuedAt: '2026-11-03 12:00:00',
    expiresAt: '2026-11-04 12:00:00',
    ip: null,
    userAgent: null,
    now: NOW,
  };
}

test('the observed REVOKED identity never resolves or recreates itself through verified email', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    link(db, { status: 'REVOKED', revokedAt: '2026-11-02 00:00:00' });
    const before = db.raw.prepare('SELECT * FROM auth_federated_identities').get();
    assert.equal((await resolveFederatedUser(client(db), input)).kind, 'ineligible');
    assert.deepEqual(db.raw.prepare('SELECT * FROM auth_federated_identities').get(), before);
    assert.equal(count(db, 'auth_federated_identities'), 1);
    assert.equal(count(db, 'auth_sessions'), 0);
    assert.equal(count(db, 'audit_events'), 0);
  } finally {
    db.close();
  }
});

test('an ACTIVE link with revoked_at populated is refused too', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    link(db, { revokedAt: '2026-11-02 00:00:00' });
    assert.equal((await resolveFederatedUser(client(db), input)).kind, 'ineligible');
  } finally {
    db.close();
  }
});

test('same provider/subject under different issuers resolves and updates only the exact identity', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    user(db, 'OTHER', 'other@customer.example');
    link(db);
    link(db, { id: 'OTHER-FID', owner: 'OTHER', issuer: 'accounts.google.com' });
    const otherBefore = db.raw
      .prepare("SELECT * FROM auth_federated_identities WHERE federated_identity_id='OTHER-FID'")
      .get();
    const resolved = await resolveFederatedUser(client(db), {
      ...input,
      email: 'changed@customer.example',
    });
    assert.equal(resolved.kind, 'user');
    if (resolved.kind !== 'user') throw new Error('Expected linked user');
    assert.equal(resolved.userId, 'USER');
    assert.equal(resolved.federatedIdentityId, 'FID');
    assert.equal(
      db.raw
        .prepare(
          "SELECT provider_email FROM auth_federated_identities WHERE federated_identity_id='FID'",
        )
        .get()?.provider_email,
      'changed@customer.example',
    );
    assert.deepEqual(
      db.raw
        .prepare("SELECT * FROM auth_federated_identities WHERE federated_identity_id='OTHER-FID'")
        .get(),
      otherBefore,
    );
    assert.equal(
      db.raw.prepare("SELECT email FROM users WHERE user_id='USER'").get()?.email,
      input.email,
    );
    const other = await resolveFederatedUser(client(db), {
      ...input,
      issuer: 'accounts.google.com',
      email: 'other@customer.example',
    });
    assert.equal(other.kind, 'user');
    if (other.kind === 'user') assert.equal(other.userId, 'OTHER');
  } finally {
    db.close();
  }
});

for (const override of [
  { emailVerified: false },
  { issuer: 'https://untrusted.example' },
  { subject: '' },
  { issuer: '' },
]) {
  test(`linked identity cannot bypass claim validation: ${JSON.stringify(override)}`, async () => {
    const db = createRegistrationDb();
    try {
      user(db);
      link(db);
      assert.notEqual(
        (await resolveFederatedUser(client(db), { ...input, ...override })).kind,
        'user',
      );
      assert.equal(
        db.raw.prepare('SELECT last_login_at FROM auth_federated_identities').get()?.last_login_at,
        null,
      );
    } finally {
      db.close();
    }
  });
}
for (const status of ['INVITED', 'SUSPENDED', 'INACTIVE']) {
  test(`a linked ${status} user cannot sign in`, async () => {
    const db = createRegistrationDb();
    try {
      user(db, 'USER', input.email, 'EXTERNAL', status);
      link(db);
      assert.equal((await resolveFederatedUser(client(db), input)).kind, 'ineligible');
    } finally {
      db.close();
    }
  });
}
for (const provider of ['GOOGLE', 'MICROSOFT'] as const) {
  test(`${provider} automatic linking uses the observed key/issuer fields and is idempotent`, async () => {
    const db = createRegistrationDb();
    try {
      user(db, 'USER', input.email, 'INTERNAL');
      const identity = { ...input, provider, issuer: provider === 'GOOGLE' ? GOOGLE : MS };
      const first = await resolveFederatedUser(client(db), identity);
      const again = await resolveFederatedUser(client(db), identity);
      assert.equal(first.kind, 'user');
      assert.equal(again.kind, 'user');
      const row = db.raw.prepare('SELECT * FROM auth_federated_identities').get()!;
      assert.equal(row.issuer, identity.issuer);
      assert.equal(row.status, 'ACTIVE');
      assert.equal(row.revoked_at, null);
      assert.equal(row.user_id, 'USER');
      assert.equal(count(db, 'audit_events'), 1);
      assert.equal(count(db, 'users'), 1);
      assert.equal(count(db, 'auth_sessions'), 0);
      assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });
}

test('unknown/unverified users are not provisioned by sign-in', async () => {
  const db = createRegistrationDb();
  try {
    assert.equal((await resolveFederatedUser(client(db), input)).kind, 'unknown');
    user(db, 'USER', input.email, 'EXTERNAL', 'INVITED');
    assert.equal((await resolveFederatedUser(client(db), input)).kind, 'ineligible');
    assert.equal(count(db, 'auth_federated_identities'), 0);
  } finally {
    db.close();
  }
});

for (const status of ['ACTIVE', 'REVOKED']) {
  test(`different issuer or subject cannot bypass an existing ${status} provider link`, async () => {
    const db = createRegistrationDb();
    try {
      user(db);
      link(db, { status, revokedAt: status === 'REVOKED' ? '2026-11-02 00:00:00' : null });
      for (const override of [{ issuer: 'accounts.google.com' }, { subject: 'another-subject' }])
        assert.equal(
          (await resolveFederatedUser(client(db), { ...input, ...override })).kind,
          'link_required',
        );
      assert.equal(count(db, 'auth_federated_identities'), 1);
      assert.equal(count(db, 'audit_events'), 0);
    } finally {
      db.close();
    }
  });
}

test('link creation and its audit event roll back together', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    db.raw.exec(
      "CREATE TRIGGER fail_link_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    await assert.rejects(() => resolveFederatedUser(client(db), input), /audit unavailable/);
    assert.equal(count(db, 'auth_federated_identities'), 0);
    db.raw.exec('DROP TRIGGER fail_link_audit');
    assert.equal((await resolveFederatedUser(client(db), input)).kind, 'user');
  } finally {
    db.close();
  }
});

test('concurrent automatic linking creates one identity and one link audit', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    const results = await Promise.all([
      resolveFederatedUser(client(db), input),
      resolveFederatedUser(client(db), input),
    ]);
    for (const result of results) assert.equal(result.kind, 'user');
    assert.equal(count(db, 'auth_federated_identities'), 1);
    assert.equal(count(db, 'audit_events'), 1);
  } finally {
    db.close();
  }
});

test('Apple may use an existing link but cannot automatically link internal users or externals without membership', async () => {
  const db = createRegistrationDb();
  try {
    user(db, 'USER', input.email, 'INTERNAL');
    const apple = { ...input, provider: 'APPLE' as const, issuer: 'https://appleid.apple.com' };
    assert.equal((await resolveFederatedUser(client(db), apple)).kind, 'link_required');
    db.raw.exec("UPDATE users SET user_type='EXTERNAL'");
    assert.equal((await resolveFederatedUser(client(db), apple)).kind, 'link_required');
    link(db, { provider: 'APPLE', issuer: apple.issuer });
    assert.equal((await resolveFederatedUser(client(db), apple)).kind, 'user');
  } finally {
    db.close();
  }
});

test('an eligible exact identity issues a session and success audit atomically', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    link(db);
    assert.equal(await createFederatedSession(client(db), sessionInput()), true);
    assert.equal(count(db, 'auth_sessions'), 1);
    assert.equal(count(db, 'audit_events'), 1);
    assert.equal(
      db.raw.prepare('SELECT last_login_at FROM users').get()?.last_login_at,
      '2026-11-03 12:00:00',
    );
  } finally {
    db.close();
  }
});

for (const change of [
  "UPDATE auth_federated_identities SET status='REVOKED',revoked_at='2026-11-03 12:00:00'",
  "UPDATE users SET status='SUSPENDED'",
  "UPDATE auth_federated_identities SET issuer='accounts.google.com'",
]) {
  test(`session issuance rechecks revocation/eligibility after lookup: ${change}`, async () => {
    const db = createRegistrationDb();
    try {
      user(db);
      link(db);
      assert.equal((await resolveFederatedUser(client(db), input)).kind, 'user');
      db.raw.exec(change);
      assert.equal(await createFederatedSession(client(db), sessionInput()), false);
      assert.equal(count(db, 'auth_sessions'), 0);
      assert.equal(count(db, 'audit_events'), 0);
      assert.equal(db.raw.prepare('SELECT last_login_at FROM users').get()?.last_login_at, null);
    } finally {
      db.close();
    }
  });
}

test('a session audit failure rolls back session and user last-login updates', async () => {
  const db = createRegistrationDb();
  try {
    user(db);
    link(db);
    db.raw.exec(
      "CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    await assert.rejects(
      () => createFederatedSession(client(db), sessionInput()),
      /audit unavailable/,
    );
    assert.equal(count(db, 'auth_sessions'), 0);
    assert.equal(db.raw.prepare('SELECT last_login_at FROM users').get()?.last_login_at, null);
  } finally {
    db.close();
  }
});
