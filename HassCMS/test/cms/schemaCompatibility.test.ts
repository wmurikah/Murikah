import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import {
  checkSchemaCompatibility,
  READINESS_TABLES,
  schemaContract,
} from '../../src/lib/cms/schema/compatibility.ts';
import { checkCmsHealth, healthHttpStatus } from '../../src/lib/cms/health.ts';
import { verifySlaTables } from '../../src/lib/cms/sla/engine.ts';
import { tokens } from '../../src/lib/cms/schema/inspect.ts';

const client = (db: TestClient) => db as unknown as Parameters<typeof checkSchemaCompatibility>[0];
function rebuild(db: TestClient, table: string, change: (ddl: string) => string) {
  const saved = db.raw
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE (name=? AND type='table') OR (tbl_name=? AND type='index' AND sql IS NOT NULL) ORDER BY type DESC",
    )
    .all(table, table);
  const ddl = saved.map((r) => change(String(r.sql)) + ';').join('\n');
  db.raw.exec(`PRAGMA foreign_keys=OFF; DROP TABLE "${table}";`);
  db.raw.exec(ddl);
  db.raw.exec('PRAGMA foreign_keys=ON');
}

test('reviewed SQL, generated contract and all shared integration tables agree', async () => {
  const db = createTestDb();
  try {
    assert.equal(Object.keys(schemaContract).length, 91);
    assert.deepEqual(await checkSchemaCompatibility(client(db)), { ok: true, issues: [] });
    for (const table of [
      'auth_email_domain_policies',
      'channel_credentials',
      'channel_provider_settings',
    ])
      assert.ok(schemaContract[table]);
    const health = await checkCmsHealth(client(db), 'schema-test');
    assert.equal(health.status, 'ok');
    assert.equal(healthHttpStatus(health.status), 200);
  } finally {
    db.close();
  }
});

const gaps: [string, string, (db: TestClient) => void][] = [
  [
    'missing OIDC storage',
    'auth_oidc_transactions',
    (db) => db.raw.exec('DROP TABLE auth_oidc_transactions'),
  ],
  [
    'old registration request key',
    'customer_access_requests',
    (db) =>
      db.raw.exec(
        'ALTER TABLE customer_access_requests RENAME COLUMN access_request_id TO request_id',
      ),
  ],
  [
    'nullable registration user',
    'customer_access_requests',
    (db) =>
      rebuild(db, 'customer_access_requests', (s) =>
        s.replace(/user_id TEXT NOT NULL/, 'user_id TEXT'),
      ),
  ],
  [
    'old password method constraint',
    'customer_access_requests',
    (db) =>
      rebuild(db, 'customer_access_requests', (s) =>
        s.replaceAll("'EMAIL_PASSWORD'", "'PASSWORD'"),
      ),
  ],
  [
    'identity key omits issuer',
    'auth_federated_identities',
    (db) =>
      rebuild(db, 'auth_federated_identities', (s) =>
        s.replace(
          /UNIQUE\(provider, issuer, provider_subject\)/,
          'UNIQUE(provider, provider_subject)',
        ),
      ),
  ],
  [
    'revocation CHECK removed',
    'auth_federated_identities',
    (db) =>
      rebuild(db, 'auth_federated_identities', (s) =>
        s.replace(/CHECK\(\s*status != 'REVOKED'\s*OR revoked_at IS NOT NULL\s*\)/, 'CHECK(1)'),
      ),
  ],
  [
    'inbox contact name mismatch',
    'contacts',
    (db) => db.raw.exec('ALTER TABLE contacts RENAME COLUMN full_name TO first_name'),
  ],
  [
    'survey invitation timestamp mismatch',
    'survey_invitations',
    (db) => db.raw.exec('ALTER TABLE survey_invitations RENAME COLUMN issued_at TO invited_at'),
  ],
  [
    'escalation write timestamp mismatch',
    'sla_escalation_events',
    (db) =>
      db.raw.exec('ALTER TABLE sla_escalation_events RENAME COLUMN triggered_at TO escalated_at'),
  ],
  [
    'breach FK removed',
    'sla_breaches',
    (db) =>
      rebuild(db, 'sla_breaches', (s) =>
        s.replace(
          /FOREIGN KEY \(sla_instance_id\) REFERENCES sla_instances\(sla_instance_id\) ON DELETE CASCADE,?/,
          '',
        ),
      ),
  ],
  [
    'SO numeric affinity drift',
    'so_extract_rows',
    (db) =>
      rebuild(db, 'so_extract_rows', (s) =>
        s.replace(/finance_variance\s+REAL/, 'finance_variance TEXT'),
      ),
  ],
  [
    'PO row hash nullability drift',
    'po_extract_rows',
    (db) =>
      rebuild(db, 'po_extract_rows', (s) =>
        s.replace(/row_hash\s+TEXT\s*,/, 'row_hash TEXT NOT NULL,'),
      ),
  ],
  [
    'request email collation drift',
    'customer_access_requests',
    (db) =>
      rebuild(db, 'customer_access_requests', (s) =>
        s.replace(
          'email_at_request TEXT NOT NULL COLLATE NOCASE',
          'email_at_request TEXT NOT NULL COLLATE BINARY',
        ),
      ),
  ],
];
for (const [name, table, mutate] of gaps) {
  test(`readiness refuses schema gap: ${name}`, async (t) => {
    const db = createTestDb();
    t.mock.method(console, 'error', () => {});
    try {
      mutate(db);
      const result = await checkSchemaCompatibility(client(db), READINESS_TABLES);
      assert.ok(
        result.issues.some((i) => i.table === table),
        JSON.stringify(result),
      );
      assert.equal(result.ok, false);
      const health = await checkCmsHealth(client(db), 'schema-test');
      assert.equal(health.status, 'degraded');
      assert.equal(healthHttpStatus(health.status), 503);
      assert.ok(
        !JSON.stringify(health).includes(table),
        'public health must not expose schema names',
      );
    } finally {
      db.close();
    }
  });
}

test('SLA guard rejects a same-name table with incompatible writer columns', async () => {
  const db = createTestDb();
  try {
    db.raw.exec('ALTER TABLE sla_escalation_events RENAME COLUMN triggered_at TO escalated_at');
    const result = await verifySlaTables(client(db) as never);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('sla_escalation_events'));
  } finally {
    db.close();
  }
});

test('schema inspection is a single metadata-only query and accepts unrelated tables/index changes', async () => {
  const db = createTestDb();
  try {
    db.raw.exec(
      'CREATE TABLE unrelated(extra TEXT); CREATE INDEX optional_notifications ON notifications(title); ALTER TABLE contacts ADD COLUMN optional_note TEXT',
    );
    const queries: string[] = [];
    const inspect = {
      async execute(stmt: Parameters<TestClient['execute']>[0]) {
        queries.push(typeof stmt === 'string' ? stmt : stmt.sql);
        return db.execute(stmt);
      },
    };
    assert.equal((await checkSchemaCompatibility(inspect as never, READINESS_TABLES)).ok, true);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM sqlite_schema/);
    assert.doesNotMatch(queries[0]!, /\b(INSERT|UPDATE|DELETE|COUNT\(\*\))\b/i);
  } finally {
    db.close();
  }
});

test('CHECK token normalization preserves literals and ignores comments/identifier quotes', () => {
  assert.deepEqual(
    tokens("\"status\" IN ('ACTIVE', 'REVOKED') -- note"),
    tokens("status in ('ACTIVE','REVOKED')"),
  );
  assert.notDeepEqual(tokens("status='active'"), tokens("status='ACTIVE'"));
});

test('unreachable database and unreadable metadata do not report healthy or expose errors', async (t) => {
  t.mock.method(console, 'error', () => {});
  const unreachable = {
    async execute() {
      throw new Error('sensitive connection details');
    },
  };
  const down = await checkCmsHealth(unreachable as never, 'test');
  assert.equal(down.status, 'down');
  const partial = {
    async execute(sql: unknown) {
      if (sql === 'SELECT 1') return { rows: [] };
      throw new Error('sensitive SQL');
    },
  };
  const degraded = await checkCmsHealth(partial as never, 'test');
  assert.equal(degraded.status, 'degraded');
  assert.doesNotMatch(JSON.stringify([down, degraded]), /sensitive/);
});
