import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createRegistrationDb } from './support/registrationDb.ts';
import {
  createCustomerAccessRequest,
  RegistrationConflictError,
} from '../../src/lib/cms/repos/identityGateway.ts';
import {
  createRegistrationGrant,
  verifyRegistrationGrant,
} from '../../src/lib/cms/auth/registrationGrant.ts';
import { loadIdentity } from '../../src/lib/cms/repos/identity.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const SECRET = crypto.randomUUID() + crypto.randomUUID();
const input = {
  email: 'applicant@customer.example',
  provider: 'GOOGLE' as const,
  providerSubject: 'verified-subject',
  providerIssuer: 'https://accounts.google.com',
  providerTenantId: null,
  identityVerifiedAt: NOW,
  companyName: 'Customer Limited',
  contactName: 'Applicant Person',
  now: NOW,
  ip: null,
  userAgent: null,
};
type Db = ReturnType<typeof createRegistrationDb>;
const client = (db: Db) => db as unknown as Parameters<typeof createCustomerAccessRequest>[0];
const count = (db: Db, table: string) =>
  Number(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const noAccess = (db: Db) => {
  for (const table of [
    'auth_sessions',
    'auth_credentials',
    'customer_portal_memberships',
    'user_roles',
    'accounts',
    'contacts',
  ])
    assert.equal(count(db, table), 0, table);
};

for (const provider of ['GOOGLE', 'MICROSOFT'] as const) {
  test(`${provider} request uses the live constraints and creates only an invited external applicant`, async () => {
    const db = createRegistrationDb();
    try {
      const requestId = await createCustomerAccessRequest(client(db), {
        ...input,
        provider,
        providerIssuer:
          provider === 'GOOGLE'
            ? input.providerIssuer
            : 'https://login.microsoftonline.com/12345678-abcd-1234-abcd-123456789abc/v2.0',
      });
      const request = db.raw.prepare('SELECT * FROM customer_access_requests').get()!;
      const user = db.raw.prepare('SELECT * FROM users').get()!;
      const identity = db.raw.prepare('SELECT * FROM auth_federated_identities').get()!;
      assert.equal(request.access_request_id, requestId);
      assert.equal(request.user_id, user.user_id);
      assert.equal(request.federated_identity_id, identity.federated_identity_id);
      assert.equal(request.identity_method, provider);
      assert.equal(request.email_at_request, input.email);
      assert.equal(request.identity_verified_at, '2026-11-03 12:00:00');
      assert.equal(request.company_name, input.companyName);
      assert.equal(request.status, 'PENDING');
      assert.equal(request.requested_account_id, null);
      assert.equal(request.approved_membership_id, null);
      assert.equal(user.user_type, 'EXTERNAL');
      assert.equal(user.status, 'INVITED');
      assert.equal(user.display_name, input.contactName);
      assert.equal(identity.provider_email_verified, 1);
      assert.equal(identity.status, 'ACTIVE');
      assert.equal(await loadIdentity(client(db), String(user.user_id)), null);
      noAccess(db);
      assert.equal(count(db, 'audit_events'), 1);
      assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });
}

test('retries and simultaneous requests create one applicant, identity, pending request and audit event', async () => {
  const db = createRegistrationDb();
  try {
    const ids = await Promise.all([
      createCustomerAccessRequest(client(db), input),
      createCustomerAccessRequest(client(db), input),
    ]);
    assert.equal(ids[0], ids[1]);
    assert.equal(
      await createCustomerAccessRequest(client(db), {
        ...input,
        companyName: 'Do not overwrite request',
      }),
      ids[0],
    );
    for (const table of [
      'users',
      'auth_federated_identities',
      'customer_access_requests',
      'audit_events',
    ])
      assert.equal(count(db, table), 1, table);
    assert.equal(
      db.raw.prepare('SELECT company_name FROM customer_access_requests').get()?.company_name,
      input.companyName,
    );
    noAccess(db);
  } finally {
    db.close();
  }
});

test('a failed request/audit write rolls back the applicant and provider identity as well', async () => {
  const db = createRegistrationDb();
  try {
    db.raw.exec(
      "CREATE TRIGGER reject_registration_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    await assert.rejects(() => createCustomerAccessRequest(client(db), input), /audit unavailable/);
    for (const table of [
      'users',
      'auth_federated_identities',
      'customer_access_requests',
      'audit_events',
    ])
      assert.equal(count(db, table), 0, table);
    db.raw.exec('DROP TRIGGER reject_registration_audit');
    await createCustomerAccessRequest(client(db), input);
    assert.equal(count(db, 'customer_access_requests'), 1);
  } finally {
    db.close();
  }
});

for (const userType of ['INTERNAL', 'EXTERNAL']) {
  test(`registration cannot adopt an existing ${userType} user merely by verified email`, async () => {
    const db = createRegistrationDb();
    try {
      db.raw
        .prepare(
          "INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,status,email_verified_at) VALUES('EXISTING',?,'Existing','User','Existing User',?,'ACTIVE','2026-01-01 00:00:00')",
        )
        .run(userType, input.email);
      await assert.rejects(
        () => createCustomerAccessRequest(client(db), input),
        RegistrationConflictError,
      );
      assert.equal(db.raw.prepare('SELECT status FROM users').get()?.status, 'ACTIVE');
      assert.equal(count(db, 'customer_access_requests'), 0);
      assert.equal(count(db, 'auth_federated_identities'), 0);
    } finally {
      db.close();
    }
  });
}

for (const change of [
  "UPDATE auth_federated_identities SET status='REVOKED',revoked_at='2026-11-03 12:00:00'",
  "UPDATE users SET status='SUSPENDED'",
  "UPDATE users SET status='INACTIVE'",
  "UPDATE users SET user_type='INTERNAL'",
]) {
  test(`existing registration identity is refused after: ${change}`, async () => {
    const db = createRegistrationDb();
    try {
      await createCustomerAccessRequest(client(db), input);
      db.raw.exec(change);
      await assert.rejects(
        () => createCustomerAccessRequest(client(db), input),
        RegistrationConflictError,
      );
      assert.equal(count(db, 'customer_access_requests'), 1);
    } finally {
      db.close();
    }
  });
}

test('issuer and subject are binding: another provider identity cannot adopt the pending email', async () => {
  const db = createRegistrationDb();
  try {
    await createCustomerAccessRequest(client(db), input);
    await assert.rejects(
      () => createCustomerAccessRequest(client(db), { ...input, providerSubject: 'other-subject' }),
      RegistrationConflictError,
    );
    await assert.rejects(
      () =>
        createCustomerAccessRequest(client(db), {
          ...input,
          providerIssuer: 'accounts.google.com',
        }),
      RegistrationConflictError,
    );
    assert.equal(count(db, 'auth_federated_identities'), 1);
  } finally {
    db.close();
  }
});

test('consumer/internal domains, unsupported password identity and stale verification cannot create applicants', async () => {
  const db = createRegistrationDb();
  try {
    for (const override of [
      { email: 'applicant@gmail.com' },
      { email: 'employee@hasspetroleum.com' },
      { provider: 'PASSWORD' },
      { providerIssuer: 'https://untrusted.example' },
      { providerSubject: '' },
      { identityVerifiedAt: new Date(NOW.getTime() - 10 * 60_000) },
      { identityVerifiedAt: new Date(NOW.getTime() + 1000) },
    ])
      await assert.rejects(
        () => createCustomerAccessRequest(client(db), { ...input, ...override } as typeof input),
        RegistrationConflictError,
      );
    assert.equal(count(db, 'users'), 0);
    noAccess(db);
  } finally {
    db.close();
  }
});

test('verified registration grants retain issuer/tenant/time; old or malformed grants require re-verification', async () => {
  const grant = await createRegistrationGrant(SECRET, {
    email: input.email,
    provider: 'GOOGLE',
    subject: input.providerSubject,
    providerIssuer: input.providerIssuer,
    tenantId: null,
  });
  const verified = await verifyRegistrationGrant(SECRET, grant);
  assert.equal(verified.providerIssuer, input.providerIssuer);
  assert.equal(verified.tenantId, null);
  assert.ok(Number.isFinite(Date.parse(verified.verifiedAt)));
  for (const payload of [
    { email: input.email, provider: 'GOOGLE', subject: input.providerSubject },
    {
      email: input.email,
      provider: 'GOOGLE',
      subject: '',
      providerIssuer: input.providerIssuer,
      tenantId: null,
    },
    {
      email: input.email,
      provider: 'GOOGLE',
      subject: 'subject',
      providerIssuer: 'https://untrusted.example',
      tenantId: null,
    },
  ]) {
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('hass-cms')
      .setAudience('customer-registration')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(SECRET));
    await assert.rejects(
      () => verifyRegistrationGrant(SECRET, token),
      /invalid_registration_grant/,
    );
  }
});

test('an existing eligible external identity can submit after a closed request without changing its profile', async () => {
  const db = createRegistrationDb();
  try {
    const previousId = await createCustomerAccessRequest(client(db), input);
    db.raw.exec(
      "UPDATE customer_access_requests SET status='REJECTED'; UPDATE users SET status='ACTIVE'",
    );
    const beforeUser = db.raw.prepare('SELECT * FROM users').get();
    const beforeIdentity = db.raw.prepare('SELECT * FROM auth_federated_identities').get();
    const nextId = await createCustomerAccessRequest(client(db), {
      ...input,
      contactName: 'Do not change profile',
    });
    assert.notEqual(nextId, previousId);
    assert.equal(count(db, 'users'), 1);
    assert.equal(count(db, 'auth_federated_identities'), 1);
    assert.equal(count(db, 'customer_access_requests'), 2);
    assert.deepEqual(db.raw.prepare('SELECT * FROM users').get(), beforeUser);
    assert.deepEqual(
      db.raw.prepare('SELECT * FROM auth_federated_identities').get(),
      beforeIdentity,
    );
    noAccess(db);
  } finally {
    db.close();
  }
});

test('existing EMAIL_PASSWORD requests and applicants are preserved verbatim', async () => {
  const db = createRegistrationDb();
  try {
    db.raw.exec(`INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,status)
      VALUES('LEGACY','EXTERNAL','Legacy','Applicant','Legacy Applicant','legacy@customer.example','INVITED');
      INSERT INTO customer_access_requests(access_request_id,user_id,identity_method,email_at_request,email_domain,company_name)
      VALUES('LEGACY-REQUEST','LEGACY','EMAIL_PASSWORD','legacy@customer.example','customer.example','Legacy company')`);
    const before = db.raw
      .prepare("SELECT * FROM customer_access_requests WHERE access_request_id='LEGACY-REQUEST'")
      .get();
    const beforeUser = db.raw.prepare("SELECT * FROM users WHERE user_id='LEGACY'").get();
    await createCustomerAccessRequest(client(db), input);
    assert.deepEqual(
      db.raw
        .prepare("SELECT * FROM customer_access_requests WHERE access_request_id='LEGACY-REQUEST'")
        .get(),
      before,
    );
    assert.deepEqual(
      db.raw.prepare("SELECT * FROM users WHERE user_id='LEGACY'").get(),
      beforeUser,
    );
    assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
