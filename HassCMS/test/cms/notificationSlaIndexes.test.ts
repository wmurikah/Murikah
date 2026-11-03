import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { unreadCount, notify } from '../../src/lib/cms/notify/notifications.ts';
import { sweepDueSlas } from '../../src/lib/cms/sla/engine.ts';

type Statement = { sql: string; args: unknown[] };
const migration = readFileSync(
  new URL('../../db/migrations/004_notification_sla_indexes.sql', import.meta.url),
  'utf8',
);
const verification = migration.slice(migration.indexOf('WITH expected('));
const NOW = new Date('2026-11-03T12:00:00Z');

async function productionQueries() {
  const queries: Statement[] = [];
  const capture = {
    async execute(stmt: string | Statement) {
      queries.push(typeof stmt === 'string' ? { sql: stmt, args: [] } : stmt);
      return { rows: [], rowsAffected: 0 };
    },
  } as unknown as Parameters<typeof unreadCount>[0];
  await unreadCount(capture, SEED.admin);
  await notify(capture, {
    userId: SEED.admin,
    type: 'SLA_WARNING',
    title: 'Plan probe',
    message: 'Plan probe',
    entityType: 'SLA_INSTANCE',
    entityId: 'PERF-0',
    at: NOW,
  });
  await sweepDueSlas(capture, NOW);
  assert.equal(queries.length, 4);
  return queries;
}

async function baseline() {
  const db = createTestDb();
  await seedHass(db);
  // The historical fixture already has helper indexes absent from the live
  // export. Remove those on the queried tables, keeping UNIQUE/PK constraints.
  for (const table of ['notifications', 'sla_instances', 'sla_timer_events']) {
    const indexes = db.raw.prepare(`PRAGMA index_list('${table}')`).all();
    for (const index of indexes)
      if (index.origin === 'c' && !index.unique) db.raw.exec(`DROP INDEX "${String(index.name)}"`);
  }
  // This is the entity index present in the operator's actual export.
  db.raw.exec('CREATE INDEX idx_sla_entity ON sla_instances(entity_type,entity_id,status)');
  db.raw.exec('BEGIN');
  try {
    const users = db.raw
      .prepare('SELECT user_id FROM users ORDER BY user_id')
      .all()
      .map((row) => String(row.user_id));
    const notification = db.raw.prepare(`INSERT INTO notifications(
      notification_id,user_id,notification_type,title,message,entity_type,entity_id,created_at,read_at)
      VALUES(?,?,'SLA_WARNING','Synthetic notification','Synthetic data','SLA_INSTANCE',?,'2026-11-03 10:00:00',?)`);
    for (let i = 0; i < 30_000; i++)
      notification.run(
        `PERF-N-${i}`,
        i % 10 === 0 ? SEED.admin : users[i % users.length]!,
        `PERF-${i}`,
        i % 4 === 0 ? null : '2026-11-03 11:00:00',
      );
    const instance = db.raw.prepare(`INSERT INTO sla_instances(
      sla_instance_id,sla_rule_id,entity_type,entity_id,started_at,target_at,warning_at,status)
      VALUES(?,'SLAR-001','CASE',?,'2026-11-01 07:00:00',?,?,?)`);
    const timer = db.raw
      .prepare(`INSERT INTO sla_timer_events(sla_timer_event_id,sla_instance_id,event_type,event_at)
      VALUES(?,?,?,'2026-11-01 07:00:00')`);
    for (let i = 0; i < 3_000; i++) {
      const id = `PERF-I-${i}`;
      instance.run(
        id,
        `PERF-CASE-${i}`,
        '2026-11-02 08:00:00',
        '2026-11-02 07:45:00',
        i % 10 === 0 ? 'RUNNING' : 'MET',
      );
      for (let j = 0; j < 4; j++)
        timer.run(`PERF-T-${i}-${j}`, id, j === 0 && i % 20 === 0 ? 'WARNING' : 'START');
    }
    db.raw.exec('COMMIT');
  } catch (error) {
    db.raw.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

function plans(db: TestClient, queries: Statement[]) {
  return queries.map((q) =>
    db.raw
      .prepare('EXPLAIN QUERY PLAN ' + q.sql)
      .all(...(q.args as never[]))
      .map((row) => String(row.detail))
      .join('\n'),
  );
}
function selectedRows(db: TestClient, queries: Statement[]) {
  return [queries[0]!, queries[2]!, queries[3]!].map((q) =>
    db.raw
      .prepare(q.sql)
      .all(...(q.args as never[]))
      .map((row) => JSON.stringify(row))
      .sort(),
  );
}

// Real predicates and mixed lifecycle states, not an empty test database.
test('migration turns notification/SLA scans into indexed searches without changing results or rows', async () => {
  const db = await baseline();
  try {
    const queries = await productionQueries();
    db.raw.exec('ANALYZE');
    const beforePlans = plans(db, queries),
      beforeRows = selectedRows(db, queries);
    assert.match(beforePlans[0]!, /SCAN notifications/);
    assert.match(beforePlans[1]!, /SCAN notifications/);
    assert.match(beforePlans[2]!, /SCAN i/);
    assert.match(beforePlans[2]!, /SCAN e/);
    assert.match(beforePlans[3]!, /SCAN sla_instances/);
    const counts = () =>
      ['notifications', 'sla_instances', 'sla_timer_events'].map(
        (table) => db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      );
    const beforeCounts = counts();
    db.raw.exec(migration);
    db.raw.exec('ANALYZE');
    assert.equal(
      db.raw
        .prepare(verification)
        .all()
        .filter((row) => row.verification === 'OK').length,
      5,
    );
    const afterPlans = plans(db, queries);
    assert.match(
      afterPlans[0]!,
      /SEARCH notifications USING COVERING INDEX idx_notifications_user_unread/,
    );
    assert.match(
      afterPlans[1]!,
      /SEARCH notifications USING COVERING INDEX idx_notifications_dedup/,
    );
    assert.match(afterPlans[2]!, /SEARCH i USING INDEX idx_sla_instances_warning/);
    assert.match(afterPlans[2]!, /SEARCH e USING COVERING INDEX idx_sla_timer_instance_event/);
    assert.match(afterPlans[3]!, /SEARCH sla_instances USING INDEX idx_sla_instances_due/);
    assert.deepEqual(selectedRows(db, queries), beforeRows);
    // The actual write guard remains idempotent with the new dedup index.
    assert.equal((await db.execute(queries[1]! as never)).rowsAffected, 0);
    db.raw.exec(migration);
    assert.deepEqual(counts(), beforeCounts);
    assert.equal(
      db.raw
        .prepare(verification)
        .all()
        .filter((row) => row.verification === 'OK').length,
      5,
    );
    assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('existing compatible due index is retained and the migration remains rerunnable', () => {
  const db = createTestDb();
  try {
    const original = db.raw
      .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_sla_instances_due'")
      .get()?.sql;
    db.raw.exec(migration);
    db.raw.exec(migration);
    assert.equal(
      db.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_sla_instances_due'").get()?.sql,
      original,
    );
    assert.equal(
      db.raw
        .prepare(verification)
        .all()
        .filter((row) => row.verification === 'OK').length,
      5,
    );
  } finally {
    db.close();
  }
});

for (const definition of [
  'ON notifications(notification_id)',
  'ON notifications(user_id COLLATE NOCASE,read_at)',
  'ON notifications(user_id,read_at) WHERE read_at IS NULL',
]) {
  test(`same-name incompatible index is preserved and reported: ${definition}`, () => {
    const db = createTestDb();
    try {
      db.raw.exec('CREATE INDEX idx_notifications_user_unread ' + definition);
      const original = db.raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_notifications_user_unread'")
        .get()?.sql;
      db.raw.exec(migration);
      assert.equal(
        db.raw
          .prepare(verification)
          .all()
          .find((row) => row.index_name === 'idx_notifications_user_unread')?.verification,
        'MISSING_OR_MISMATCHED',
      );
      assert.equal(
        db.raw
          .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_notifications_user_unread'")
          .get()?.sql,
        original,
      );
    } finally {
      db.close();
    }
  });
}
