import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient, type Client } from '@libsql/client';
import { AUTH_SCHEMA_DDL } from './support/schema.ts';
import { reconcileAuthentication } from '../../db/migrations/006_reviewed_auth_reconciliation.ts';
import {
  createCustomerAccessRequest,
  resolveFederatedUser,
} from '../../src/lib/cms/repos/identityGateway.ts';
import { createOidcTransaction } from '../../src/lib/cms/repos/oidcTransactions.ts';
import { checkSchemaCompatibility } from '../../src/lib/cms/schema/compatibility.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const legacy = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.sql.txt`, import.meta.url), 'utf8');
async function setup({ missingOidc = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-auth-rollout-'));
  const db = createClient({ url: 'file:' + join(dir, 'db.sqlite') });
  await db.executeMultiple(AUTH_SCHEMA_DDL);
  if (missingOidc) await db.execute('DROP TABLE auth_oidc_transactions');
  return {
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function seed(db: Client) {
  const rows = [
    ['password', 'EMAIL_PASSWORD', 'PENDING', null, null],
    ['google', 'GOOGLE', 'PENDING', 'ACTIVE', null],
    ['microsoft', 'MICROSOFT', 'APPROVED', 'ACTIVE', '2026-11-01 10:00:00'],
    ['apple', 'APPLE', 'REJECTED', 'ACTIVE', null],
    ['revoked', 'GOOGLE', 'CANCELLED', 'REVOKED', '2026-11-01 10:00:00'],
  ];
  for (const [name, method, status, identityStatus, verifiedAt] of rows) {
    await db.execute({
      sql: `INSERT INTO users(user_id,user_type,first_name,last_name,display_name,email,status,email_verified_at)
      VALUES(?,'EXTERNAL','Synthetic','User','Synthetic User',?, ?, ?)`,
      args: [
        `u-${name}`,
        `${name}@customer.example`,
        name === 'microsoft' ? 'ACTIVE' : 'INVITED',
        verifiedAt,
      ],
    });
    if (method !== 'EMAIL_PASSWORD') {
      await db.execute({
        sql: `INSERT INTO auth_federated_identities(federated_identity_id,user_id,provider,issuer,provider_subject,provider_email,status,revoked_at)
        VALUES(?,?,?,?,?,?,?,?)`,
        args: [
          `f-${name}`,
          `u-${name}`,
          method,
          method === 'GOOGLE'
            ? 'https://accounts.google.com'
            : method === 'APPLE'
              ? 'https://appleid.apple.com'
              : 'https://login.microsoftonline.com/12345678-abcd-1234-abcd-123456789abc/v2.0',
          `subject-${name}`,
          name === 'apple' ? null : `${name}@customer.example`,
          identityStatus,
          identityStatus === 'REVOKED' ? '2026-11-02 10:00:00' : null,
        ],
      });
    }
    await db.execute({
      sql: `INSERT INTO customer_access_requests(access_request_id,user_id,identity_method,federated_identity_id,email_at_request,email_domain,company_name,status,identity_verified_at)
      VALUES(?,?,?,?,?,'customer.example','Synthetic Limited',?,?)`,
      args: [
        `r-${name}`,
        `u-${name}`,
        method,
        method === 'EMAIL_PASSWORD' ? null : `f-${name}`,
        `${name}@customer.example`,
        status,
        verifiedAt,
      ],
    });
  }
  await db.execute(
    "INSERT INTO auth_credentials(credential_id,user_id,password_hash,password_algorithm) VALUES('credential','u-password','synthetic-unusable-hash','PBKDF2')",
  );
  await db.execute(
    "INSERT INTO auth_sessions(session_id,user_id,refresh_token_hash,issued_at,expires_at,status) VALUES('existing-session','u-microsoft','synthetic-hash','2026-11-01','2026-11-10','ACTIVE')",
  );
  await db.execute(
    "INSERT INTO access_roles(role_id,role_name) VALUES('existing-role','Existing role')",
  );
  await db.execute(
    "INSERT INTO user_roles(user_role_id,user_id,role_id,effective_from) VALUES('existing-grant','u-microsoft','existing-role','2026-11-01')",
  );
  await db.execute(
    "INSERT INTO countries(country_id,iso2,country_name,timezone,currency_code) VALUES('test-country','ZZ','Synthetic','UTC','USD')",
  );
  await db.execute(
    "INSERT INTO accounts(account_id,account_name,account_type,country_id) VALUES('existing-account','Synthetic Account','CUSTOMER','test-country')",
  );
  await db.execute(
    "INSERT INTO contacts(contact_id,account_id,full_name) VALUES('existing-contact','existing-account','Synthetic Contact')",
  );
  await db.execute(
    "INSERT INTO customer_portal_memberships(portal_membership_id,user_id,account_id,contact_id,portal_role_id,status) VALUES('existing-membership','u-microsoft','existing-account','existing-contact','existing-role','ACTIVE')",
  );
  await db.execute(
    "UPDATE customer_access_requests SET requested_account_id='existing-account',requested_contact_id='existing-contact',approved_membership_id='existing-membership',reviewed_by_user_id='u-microsoft',reviewed_at='2026-11-02' WHERE access_request_id='r-microsoft'",
  );
}
async function snapshot(db: Client) {
  const schema = (
    await db.execute(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
  ).rows;
  const rows: Record<string, unknown> = {};
  for (const table of schema.filter((s) => s.type === 'table')) {
    const name = String(table.name);
    rows[name] = (
      await db.execute(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
    ).rows;
  }
  return { schema, rows };
}

test('populated observed schema previews without changes; repair adds only OIDC and preserves every existing row', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await seed(db);
    const before = await snapshot(db);
    assert.equal((await reconcileAuthentication(db)).status, 'READY_TO_ADD_OIDC');
    assert.deepEqual(await snapshot(db), before);
    const result = await reconcileAuthentication(db, { apply: true });
    assert.equal(result.status, 'APPLIED');
    assert.deepEqual(result.dataChecks, {
      foreignKeyViolations: 0,
      integrityErrors: 0,
      requestIdentityMismatches: 0,
    });
    const after = await snapshot(db);
    assert.deepEqual(
      after.schema.filter((s) => s.name !== 'auth_oidc_transactions'),
      before.schema,
    );
    delete after.rows.auth_oidc_transactions;
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(await checkSchemaCompatibility(db), { ok: true, issues: [] });
    await createOidcTransaction(db, {
      provider: 'GOOGLE',
      purpose: 'SIGN_IN',
      stateHash: 'synthetic-state',
      nonceHash: 'synthetic-nonce',
      verifier: 'synthetic-verifier',
      returnPath: '/app',
      now: NOW,
    });
    const withTransaction = await snapshot(db);
    assert.equal((await reconcileAuthentication(db, { apply: true })).status, 'ALREADY_COMPATIBLE');
    assert.deepEqual(await snapshot(db), withTransaction);
  } finally {
    close();
  }
});

test('compatible populated schema is untouched, including nullable verification, EMAIL_PASSWORD, APPLE and revoked links', async () => {
  const { db, close } = await setup();
  try {
    await seed(db);
    const before = await snapshot(db);
    for (const apply of [false, true, true]) {
      assert.equal((await reconcileAuthentication(db, { apply })).status, 'ALREADY_COMPATIBLE');
      assert.deepEqual(await snapshot(db), before);
    }
    assert.equal(
      (
        await db.execute(
          "SELECT identity_verified_at FROM customer_access_requests WHERE access_request_id='r-password'",
        )
      ).rows[0]?.identity_verified_at,
      null,
    );
    const registration = await createCustomerAccessRequest(db, {
      email: 'new-applicant@customer.example',
      provider: 'GOOGLE',
      providerSubject: 'new-subject',
      providerIssuer: 'https://accounts.google.com',
      providerTenantId: null,
      identityVerifiedAt: NOW,
      companyName: 'New Company',
      contactName: 'New Applicant',
      now: NOW,
      ip: null,
      userAgent: null,
    });
    const request = (
      await db.execute({
        sql: 'SELECT * FROM customer_access_requests WHERE access_request_id=?',
        args: [registration],
      })
    ).rows[0]!;
    assert.equal(request.identity_method, 'GOOGLE');
    assert.equal(request.status, 'PENDING');
    const userId = request.user_id;
    assert.equal(
      (await db.execute({ sql: 'SELECT status FROM users WHERE user_id=?', args: [userId] }))
        .rows[0]?.status,
      'INVITED',
    );
    for (const table of [
      'auth_sessions',
      'user_roles',
      'auth_credentials',
      'customer_portal_memberships',
    ])
      assert.equal(
        (
          await db.execute({
            sql: `SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`,
            args: [userId],
          })
        ).rows[0]?.n,
        0,
      );
    const pending = await resolveFederatedUser(db, {
      provider: 'GOOGLE',
      issuer: 'https://accounts.google.com',
      subject: 'new-subject',
      email: 'new-applicant@customer.example',
      emailVerified: true,
      tenantId: null,
      now: NOW,
    });
    assert.equal(pending.kind, 'ineligible');
    const established = await resolveFederatedUser(db, {
      provider: 'MICROSOFT',
      issuer: 'https://login.microsoftonline.com/12345678-abcd-1234-abcd-123456789abc/v2.0',
      subject: 'subject-microsoft',
      email: 'microsoft@customer.example',
      emailVerified: true,
      tenantId: null,
      now: NOW,
    });
    assert.equal(established.kind, 'user');
    // An active user cannot revive a historical revoked provider link.
    await db.execute(
      "UPDATE users SET status='ACTIVE',email_verified_at='2026-11-01' WHERE user_id='u-revoked'",
    );
    assert.equal(
      (
        await resolveFederatedUser(db, {
          provider: 'GOOGLE',
          issuer: 'https://accounts.google.com',
          subject: 'subject-revoked',
          email: 'revoked@customer.example',
          emailVerified: true,
          tenantId: null,
          now: NOW,
        })
      ).kind,
      'ineligible',
    );
  } finally {
    close();
  }
});

for (const name of ['001_phase4_identity', '002_phase4_live_schema_reconciliation']) {
  test(`${name} is retired and cannot alter a populated database`, async () => {
    const { db, close } = await setup();
    try {
      await seed(db);
      const before = await snapshot(db);
      const sql = readFileSync(new URL(`../../db/migrations/${name}.sql`, import.meta.url), 'utf8');
      assert.equal((await db.execute(sql)).rows[0]?.status, 'BLOCKED_RETIRED_MIGRATION');
      assert.deepEqual(await snapshot(db), before);
    } finally {
      close();
    }
  });
}

test('historical 001 partial application on observed tables preserves rows and needs no request rebuild', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await seed(db);
    await assert.rejects(
      db.executeMultiple(legacy('001_phase4_identity')),
      /no such column: email/,
    );
    const before = await snapshot(db);
    assert.equal((await reconcileAuthentication(db, { apply: true })).status, 'ALREADY_COMPATIBLE');
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

for (const populated of [false, true]) {
  test(`historical 002 ${populated ? 'fails on EMAIL_PASSWORD and leaves a staged table' : 'rebuilds an empty table incompatibly'}; replacement refuses without touching data`, async () => {
    const { db, close } = await setup();
    try {
      if (populated) {
        await seed(db);
        // Isolate the method failure from the independent NOT NULL failure.
        await db.execute(
          "UPDATE customer_access_requests SET identity_verified_at='2026-11-01 10:00:00'",
        );
        await assert.rejects(
          db.executeMultiple(legacy('002_phase4_live_schema_reconciliation')),
          /CHECK constraint failed/,
        );
      } else await db.executeMultiple(legacy('002_phase4_live_schema_reconciliation'));
      const before = await snapshot(db);
      const result = await reconcileAuthentication(db, { apply: true });
      assert.equal(result.status, 'BLOCKED');
      assert.ok(
        result.issues.some(
          (i) =>
            i.table ===
            (populated ? 'customer_access_requests_reconciled' : 'customer_access_requests'),
        ),
      );
      assert.deepEqual(await snapshot(db), before);
    } finally {
      close();
    }
  });
}

test('historical 002 rejects a valid nullable verification timestamp; source rows and staging are preserved', async () => {
  const { db, close } = await setup();
  try {
    await seed(db);
    await db.execute("DELETE FROM customer_access_requests WHERE access_request_id<>'r-google'");
    await assert.rejects(
      db.executeMultiple(legacy('002_phase4_live_schema_reconciliation')),
      /NOT NULL constraint failed: customer_access_requests_reconciled.identity_verified_at/,
    );
    const before = await snapshot(db);
    const result = await reconcileAuthentication(db, { apply: true });
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('historical 001 identity/request model requires review rather than inferred users or issuer values', async () => {
  const { db, close } = await setup();
  try {
    await db.execute('DROP TABLE customer_access_requests');
    await db.execute('DROP TABLE auth_federated_identities');
    await db.executeMultiple(legacy('001_phase4_identity'));
    await db.execute(
      "INSERT INTO customer_access_requests(request_id,email,email_domain,provider,company_name,status,submitted_at) VALUES('legacy-request','legacy@customer.example','customer.example','PASSWORD','Legacy','PENDING','2026-11-01')",
    );
    const before = await snapshot(db);
    const result = await reconcileAuthentication(db, { apply: true });
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.issues.some((i) => i.table === 'auth_federated_identities'));
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('partial OIDC table is refused before mutation', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await db.execute('CREATE TABLE auth_oidc_transactions(transaction_id TEXT PRIMARY KEY)');
    const before = await snapshot(db);
    assert.equal((await reconcileAuthentication(db, { apply: true })).status, 'BLOCKED');
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('existing invalid foreign keys are counted, not discarded or disclosed', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await db.execute('PRAGMA foreign_keys=OFF');
    await db.execute(
      "INSERT INTO customer_access_requests(access_request_id,user_id,identity_method,email_at_request,email_domain,company_name) VALUES('orphan','missing-user','EMAIL_PASSWORD','orphan@customer.example','customer.example','Orphan')",
    );
    const before = await snapshot(db);
    const result = await reconcileAuthentication(db, { apply: true });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.dataChecks?.foreignKeyViolations, 1);
    assert.doesNotMatch(JSON.stringify(result), /orphan|missing-user|@customer/);
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('request/identity ownership mismatches are preserved for explicit review', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await seed(db);
    await db.execute(
      "UPDATE customer_access_requests SET federated_identity_id='f-revoked' WHERE access_request_id='r-google'",
    );
    const before = await snapshot(db);
    const result = await reconcileAuthentication(db, { apply: true });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.dataChecks?.requestIdentityMismatches, 1);
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('failure after OIDC creation rolls back the entire repair', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await seed(db);
    const before = await snapshot(db);
    const wrapped = {
      async transaction(mode: 'read' | 'write') {
        const tx = await db.transaction(mode);
        let created = false;
        return {
          get closed() {
            return tx.closed;
          },
          async execute(stmt: Parameters<typeof tx.execute>[0]) {
            if (created) throw new Error('Synthetic post-create failure');
            const result = await tx.execute(stmt);
            if (
              typeof stmt === 'string' &&
              stmt.includes('CREATE TABLE IF NOT EXISTS auth_oidc_transactions')
            )
              created = true;
            return result;
          },
          commit: () => tx.commit(),
          rollback: () => tx.rollback(),
          close: () => tx.close(),
        };
      },
    };
    await assert.rejects(
      reconcileAuthentication(wrapped as never, { apply: true }),
      /Synthetic post-create failure/,
    );
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('web verification SQL compiles on populated current schema and never changes rows', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    await seed(db);
    const before = await snapshot(db);
    const sql = readFileSync(
      new URL('../../docs/cms/PHASE4_LIVE_VERIFICATION.sql', import.meta.url),
      'utf8',
    );
    await db.executeMultiple(sql);
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});

test('missing verification results cannot be mistaken for zero issues', async () => {
  const { db, close } = await setup({ missingOidc: true });
  try {
    const before = await snapshot(db);
    const wrapped = {
      async transaction(mode: 'read' | 'write') {
        const tx = await db.transaction(mode);
        return {
          get closed() {
            return tx.closed;
          },
          execute(stmt: Parameters<typeof tx.execute>[0]) {
            if (typeof stmt !== 'string' && stmt.sql.includes('pragma_foreign_key_check'))
              return Promise.resolve({ rows: [] });
            return tx.execute(stmt);
          },
          commit: () => tx.commit(),
          rollback: () => tx.rollback(),
          close: () => tx.close(),
        };
      },
    };
    await assert.rejects(
      reconcileAuthentication(wrapped as never, { apply: true }),
      /Incomplete authentication data verification/,
    );
    assert.deepEqual(await snapshot(db), before);
  } finally {
    close();
  }
});
