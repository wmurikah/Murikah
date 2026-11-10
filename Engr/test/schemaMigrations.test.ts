import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { DOMAIN_TABLES, verifySchemaContract } from '../db/schema-contract.ts';
import { auditIntegrity } from '../db/integrity.ts';

const migrationIds = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011'];

interface TestDatabase {
  client: Client;
  close(): void;
}

function database(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'engr-migration-test-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  return {
    client,
    close() {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function objectSignature(client: Client): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT type, name, sql FROM sqlite_schema
           WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    args: [],
  });
  return result.rows.map((row) => `${row.type}:${row.name}:${row.sql}`);
}

async function applyLegacySchema(client: Client): Promise<void> {
  const sql = readFileSync(
    new URL('../db/migrations/001_initial_schema.sql', import.meta.url),
    'utf8',
  );
  await client.executeMultiple(sql);
}

test('blank install reaches the canonical contract and is idempotent', async () => {
  const db = database();
  try {
    const first = await runMigrations(db.client);
    assert.deepEqual(first.applied, migrationIds);
    await verifySchemaContract(db.client);
    assert.deepEqual(Object.values(await auditIntegrity(db.client)), [0, 0, 0, 0, 0, 0]);

    const tables = await db.client.execute(
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    assert.equal(Number(tables.rows[0].n), DOMAIN_TABLES.length + 1); // migration history
    const history = await db.client.execute('SELECT id FROM schema_migrations ORDER BY id');
    assert.deepEqual(
      history.rows.map((row) => String(row.id)),
      migrationIds,
    );

    const second = await runMigrations(db.client);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, migrationIds);
  } finally {
    db.close();
  }
});

test('dashboard and queue predicates use the new indexes', async () => {
  const db = database();
  try {
    await runMigrations(db.client);
    const plans = [
      [
        "SELECT id FROM notifications WHERE status = 'QUEUED' ORDER BY created_at LIMIT 25",
        'ix_notifications_queue_created',
      ],
      [
        "SELECT COUNT(*) FROM notifications WHERE org_id = 'o' AND channel = 'IN_APP' AND status IN ('QUEUED','SENT') AND recipient_user_id = 'u'",
        'ix_notifications_unread',
      ],
      [
        "SELECT COUNT(*) FROM service_requests WHERE org_id = 'o' AND deleted_at IS NULL AND created_at >= '2026-01-01'",
        'ix_requests_org_created_active',
      ],
      [
        "SELECT COUNT(*) FROM pm_occurrences WHERE org_id = 'o' AND due_date >= '2026-01-01' AND due_date < '2027-01-01'",
        'ix_pm_occ_org_due',
      ],
    ] as const;
    for (const [query, index] of plans) {
      const result = await db.client.execute(`EXPLAIN QUERY PLAN ${query}`);
      assert.ok(
        result.rows.some((row) => String(row.detail).includes(index)),
        `${index}: ${JSON.stringify(result.rows)}`,
      );
    }
  } finally {
    db.close();
  }
});

test('integrity audit detects identity and tenant-link anomalies without changing data', async () => {
  const db = database();
  try {
    await runMigrations(db.client);
    await db.client.batch(
      [
        `INSERT INTO organisations (id, name, slug) VALUES ('one', 'One', 'one')`,
        `INSERT INTO organisations (id, name, slug) VALUES ('two', 'Two', 'two')`,
        `INSERT INTO users (id, org_id, full_name, email) VALUES ('u1', 'one', 'One', 'Person@Example.com')`,
        `INSERT INTO users (id, org_id, full_name, email) VALUES ('u2', 'two', 'Two', 'person@example.com')`,
        `INSERT INTO roles (id, org_id, code, name) VALUES ('r2', 'two', 'CUSTOM', 'Custom')`,
        `INSERT INTO user_roles (user_id, role_id) VALUES ('u1', 'r2')`,
      ],
      'write',
    );
    const counts = await auditIntegrity(db.client);
    assert.equal(counts.duplicateCanonicalEmails, 1);
    assert.equal(counts.noncanonicalEmails, 1);
    assert.equal(counts.crossOrgRoles, 1);
    assert.equal(counts.foreignKeyViolations, 0);
    assert.equal(Number((await db.client.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n), 2);
  } finally {
    db.close();
  }
});

test('legacy schema upgrades without losing representative LPO data', async () => {
  const blank = database();
  const legacy = database();
  try {
    await runMigrations(blank.client);
    await applyLegacySchema(legacy.client);
    await legacy.client.batch(
      [
        {
          sql: `INSERT INTO organisations (id, name, slug) VALUES ('org1', 'Legacy Org', 'legacy')`,
          args: [],
        },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email)
                VALUES ('user1', 'org1', 'Legacy Owner', 'owner@example.com')`,
          args: [],
        },
        {
          sql: `INSERT INTO contractors (id, org_id, name) VALUES ('contractor1', 'org1', 'Vendor')`,
          args: [],
        },
        {
          sql: `INSERT INTO lpos (id, org_id, lpo_no, contractor_id, created_by, total_minor)
                VALUES ('lpo1', 'org1', 'LPO-001', 'contractor1', 'user1', 125000)`,
          args: [],
        },
      ],
      'write',
    );

    const upgraded = await runMigrations(legacy.client);
    assert.deepEqual(upgraded.applied, migrationIds);
    const row = (
      await legacy.client.execute(
        `SELECT lpo_no, total_minor, subtotal_minor, mileage_minor, version FROM lpos WHERE id = 'lpo1'`,
      )
    ).rows[0];
    assert.equal(row.lpo_no, 'LPO-001');
    assert.equal(Number(row.total_minor), 125000);
    assert.equal(Number(row.subtotal_minor), 0);
    assert.equal(Number(row.mileage_minor), 0);
    assert.equal(Number(row.version), 1);
    const user = (
      await legacy.client.execute(`SELECT session_version FROM users WHERE id = 'user1'`)
    ).rows[0];
    assert.equal(Number(user.session_version), 0);
    assert.deepEqual(await objectSignature(legacy.client), await objectSignature(blank.client));
  } finally {
    blank.close();
    legacy.close();
  }
});

test('security changes revoke tracked sessions at the database boundary', async () => {
  const db = database();
  try {
    await runMigrations(db.client);
    await db.client.batch(
      [
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('o1', 'One', 'one')`, args: [] },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email) VALUES ('u1', 'o1', 'User', 'u@example.com')`,
          args: [],
        },
        {
          sql: `INSERT INTO roles (id, org_id, code, name) VALUES ('r1', 'o1', 'ADMIN', 'Admin')`,
          args: [],
        },
        {
          sql: `INSERT INTO auth_sessions
                  (id, user_id, org_id, session_version, privilege_level, created_at, last_seen_at, expires_at)
                VALUES ('s1', 'u1', 'o1', 0, 'STANDARD', '2026-01-01', '2026-01-01', '2030-01-01')`,
          args: [],
        },
        { sql: `INSERT INTO user_roles (user_id, role_id) VALUES ('u1', 'r1')`, args: [] },
      ],
      'write',
    );
    const session = (
      await db.client.execute(
        `SELECT revoked_at, revoked_reason FROM auth_sessions WHERE id = 's1'`,
      )
    ).rows[0];
    const user = (await db.client.execute(`SELECT session_version FROM users WHERE id = 'u1'`))
      .rows[0];
    assert.notEqual(session.revoked_at, null);
    assert.equal(session.revoked_reason, 'role assignment changed');
    assert.equal(Number(user.session_version), 1);
  } finally {
    db.close();
  }
});

test('reconciliation rolls back atomically when global email identity is ambiguous', async () => {
  const db = database();
  try {
    await applyLegacySchema(db.client);
    await db.client.batch(
      [
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('o1', 'One', 'one')`, args: [] },
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('o2', 'Two', 'two')`, args: [] },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email) VALUES ('u1', 'o1', 'One', 'same@example.com')`,
          args: [],
        },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email) VALUES ('u2', 'o2', 'Two', 'same@example.com')`,
          args: [],
        },
      ],
      'write',
    );

    await assert.rejects(
      () => runMigrations(db.client),
      /Cannot enforce global user email identity/,
    );
    const columns = await db.client.execute('PRAGMA table_info(organisations)');
    assert.equal(
      columns.rows.some((row) => row.name === 'parent_org_id'),
      false,
    );
    const history = await db.client.execute('SELECT id FROM schema_migrations ORDER BY id');
    assert.deepEqual(
      history.rows.map((row) => String(row.id)),
      ['001'],
    );
  } finally {
    db.close();
  }
});

test('generated schema snapshot is a valid canonical clean install', async () => {
  const snapshotDb = database();
  const migratedDb = database();
  try {
    const snapshot = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    await snapshotDb.client.executeMultiple(snapshot);
    await runMigrations(migratedDb.client);
    await verifySchemaContract(snapshotDb.client);
    assert.deepEqual(
      await objectSignature(snapshotDb.client),
      await objectSignature(migratedDb.client),
    );
  } finally {
    snapshotDb.close();
    migratedDb.close();
  }
});
