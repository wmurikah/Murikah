import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import {
  candidates,
  removeRedundantIndexes,
} from '../../db/migrations/005_remove_redundant_indexes.mjs';

const ddl =
  readFileSync(new URL('../../db/schema/cms.sql', import.meta.url), 'utf8') +
  '\n' +
  readFileSync(
    new URL('../../db/diagnostics/redundant_index_restore.sql', import.meta.url),
    'utf8',
  );
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cms-index-cleanup-'));
  const db = createClient({ url: 'file:' + join(dir, 'test.db') });
  const close = db.close.bind(db);
  db.close = () => {
    close();
    rmSync(dir, { recursive: true, force: true });
  };
  // Synthetic rows omit parent data; schema comes from the shared baseline.
  await db.execute('PRAGMA foreign_keys=OFF');
  await db.executeMultiple(ddl);
  return db;
}
async function schema(db) {
  return (await db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name')).rows;
}
const seeds = [
  [
    'business_units',
    ['business_unit_id', 'business_unit_code', 'business_unit_name'],
    (i) => [`b${i}`, `code${i}`, `Unit ${i}`],
  ],
  [
    'users',
    ['user_id', 'first_name', 'last_name', 'display_name', 'email', 'status'],
    (i) => [`u${i}`, 'Test', 'User', 'Test User', `user${i}@example.test`, 'INVITED'],
  ],
  [
    'accounts',
    ['account_id', 'account_name', 'account_type', 'country_id', 'oracle_customer_code'],
    (i) => [`a${i}`, `Account ${i}`, 'PROSPECT', 'c1', `oracle${i}`],
  ],
  [
    'record_snapshots',
    [
      'snapshot_id',
      'entity_type',
      'entity_id',
      'version_no',
      'row_hash',
      'snapshot_json',
      'captured_at',
    ],
    (i) => [`s${i}`, 'CASE', `e${i % 10}`, Math.floor(i / 10) + 1, 'hash', '{}', '2026-11-03'],
  ],
  [
    'sla_escalation_events',
    ['sla_escalation_event_id', 'sla_instance_id', 'escalation_level', 'triggered_at', 'status'],
    (i) => [`es${i}`, `si${i % 10}`, Math.floor(i / 10) + 1, '2026-11-03', 'SENT'],
  ],
  [
    'so_extract_rows',
    ['so_extract_row_id', 'import_batch_id', 'source_row_number'],
    (i) => [`so${i}`, `batch${i % 10}`, Math.floor(i / 10)],
  ],
  [
    'po_extract_rows',
    ['po_extract_row_id', 'import_batch_id', 'source_row_number'],
    (i) => [`po${i}`, `batch${i % 10}`, Math.floor(i / 10)],
  ],
  [
    'bot_messages',
    ['bot_message_id', 'bot_conversation_id', 'sequence_no', 'role', 'content'],
    (i) => [`m${i}`, `conv${i % 10}`, Math.floor(i / 10) + 1, 'USER', 'Synthetic'],
  ],
];

test('preview is read-only; apply preserves data, UNIQUE rules and indexed lookups; rerun is safe', async () => {
  const db = await setup();
  try {
    for (const [table, cols, values] of seeds) {
      await db.batch(
        Array.from({ length: 200 }, (_, i) => ({
          sql: `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
          args: values(i),
        })),
        'write',
      );
    }
    await db.execute('ANALYZE');
    const originalSchema = await schema(db);
    const contents = async () =>
      Promise.all(
        candidates.map(
          async ([table]) => (await db.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows,
        ),
      );
    const before = await contents();
    const preview = await removeRedundantIndexes(db);
    assert.equal(preview.filter((r) => r.status === 'WOULD_REMOVE').length, 8);
    assert.deepEqual(await schema(db), originalSchema);
    const applied = await removeRedundantIndexes(db, { apply: true });
    assert.equal(applied.filter((r) => r.status === 'REMOVED').length, 8);
    assert.deepEqual(await contents(), before);
    const dropped = new Set(candidates.map(([, name]) => name));
    assert.deepEqual(
      await schema(db),
      originalSchema.filter((r) => !dropped.has(r.name)),
    );
    await db.execute('PRAGMA foreign_keys=OFF');
    for (const [table, cols, values] of seeds) {
      const duplicate = values(0);
      duplicate[0] = 'different-primary-key';
      if (table === 'users') duplicate[4] = 'USER0@EXAMPLE.TEST';
      await assert.rejects(
        db.execute({
          sql: `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
          args: duplicate,
        }),
        /UNIQUE constraint failed/,
      );
    }
    // NULLs remain legal on the nullable UNIQUE key.
    await db.execute(
      "INSERT INTO accounts(account_id,account_name,account_type,country_id) VALUES('null1','N1','PROSPECT','c1'),('null2','N2','PROSPECT','c1')",
    );
    const rerun = await removeRedundantIndexes(db, { apply: true });
    assert.ok(rerun.every((r) => r.status === 'ALREADY_ABSENT'));
    for (const [table, , cols] of candidates) {
      const plan = await db.execute({
        sql: `EXPLAIN QUERY PLAN SELECT ${cols.join(',')} FROM ${table} WHERE ${cols.map((c) => c + '=?').join(' AND ')}`,
        args: cols.map(() => 'probe'),
      });
      assert.match(
        plan.rows.map((r) => r.detail).join('\n'),
        /SEARCH .*USING COVERING INDEX sqlite_autoindex_/,
      );
    }
    // Prefix queries still use the full UNIQUE composite key.
    for (const [table, , cols] of candidates.filter((c) => c[2].length > 1)) {
      const plan = await db.execute({
        sql: `EXPLAIN QUERY PLAN SELECT ${cols.join(',')} FROM ${table} WHERE ${cols[0]}=? ORDER BY ${cols.slice(1).join(',')}`,
        args: ['probe'],
      });
      assert.match(
        plan.rows.map((r) => r.detail).join('\n'),
        /SEARCH .*USING COVERING INDEX sqlite_autoindex_/,
      );
    }
  } finally {
    db.close();
  }
});

for (const definition of [
  'ON bot_messages(sequence_no,bot_conversation_id)',
  'ON bot_messages(bot_conversation_id)',
  'ON bot_messages(bot_conversation_id COLLATE NOCASE,sequence_no)',
  'ON bot_messages(bot_conversation_id DESC,sequence_no)',
  'ON bot_messages(bot_conversation_id,sequence_no) WHERE sequence_no>1',
  'ON bot_messages(lower(bot_conversation_id),sequence_no)',
]) {
  test(`refuses changed definition without dropping any index: ${definition}`, async () => {
    const db = await setup();
    try {
      await db.execute('DROP INDEX ix_bot_msg_conv');
      await db.execute('CREATE INDEX ix_bot_msg_conv ' + definition);
      const before = await schema(db);
      await assert.rejects(removeRedundantIndexes(db, { apply: true }), /Unexpected definition/);
      assert.deepEqual(await schema(db), before);
    } finally {
      db.close();
    }
  });
}

test('refuses a missing UNIQUE constraint even when an explicit unique index exists', async () => {
  const db = await setup();
  try {
    await db.execute('DROP TABLE business_units');
    await db.execute('CREATE TABLE business_units(business_unit_code TEXT)');
    await db.execute('CREATE INDEX idx_business_units_code ON business_units(business_unit_code)');
    await db.execute('CREATE UNIQUE INDEX substitute ON business_units(business_unit_code)');
    const before = await schema(db);
    await assert.rejects(
      removeRedundantIndexes(db, { apply: true }),
      /No matching UNIQUE constraint/,
    );
    assert.deepEqual(await schema(db), before);
  } finally {
    db.close();
  }
});

test('refuses stored SQL that forces an explicit index name', async () => {
  const db = await setup();
  try {
    await db.execute('CREATE VIEW hinted AS SELECT * FROM users INDEXED BY idx_users_email');
    const before = await schema(db);
    await assert.rejects(
      removeRedundantIndexes(db, { apply: true }),
      /may be named by view hinted/,
    );
    assert.deepEqual(await schema(db), before);
  } finally {
    db.close();
  }
});

test('a failure after the first drop rolls back the entire cleanup', async () => {
  const db = await setup();
  try {
    const before = await schema(db);
    const wrapped = {
      async transaction(mode) {
        const tx = await db.transaction(mode);
        return {
          execute(stmt) {
            if (stmt === 'DROP INDEX "idx_users_email"') throw new Error('Injected DDL failure');
            return tx.execute(stmt);
          },
          commit: () => tx.commit(),
          rollback: () => tx.rollback(),
          close: () => tx.close(),
        };
      },
    };
    await assert.rejects(removeRedundantIndexes(wrapped, { apply: true }), /Injected DDL failure/);
    assert.deepEqual(await schema(db), before);
  } finally {
    db.close();
  }
});
