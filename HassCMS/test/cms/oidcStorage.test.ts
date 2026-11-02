import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, type TestClient } from './support/db.ts';
import {
  createOidcTransaction,
  consumeOidcTransaction,
  OIDC_STORAGE_COLUMNS_SQL,
} from '../../src/lib/cms/repos/oidcTransactions.ts';

const migration = readFileSync(
  new URL('../../db/migrations/003_oidc_transactions_only.sql', import.meta.url),
  'utf8',
);
const NOW = new Date('2026-11-02T12:00:00Z');
const input = {
  provider: 'GOOGLE' as const,
  purpose: 'SIGN_IN' as const,
  stateHash: 'keyed-state-hash',
  nonceHash: 'keyed-nonce-hash',
  verifier: 'server-side-pkce-verifier',
  returnPath: '/app',
  now: NOW,
};
const asClient = (db: TestClient) => db as unknown as Parameters<typeof createOidcTransaction>[0];

function missingStorageDb() {
  const db = createTestDb();
  // Reproduce the observed production gap instead of inheriting the table
  // from the optimistic base fixture.
  db.raw.exec('DROP TABLE auth_oidc_transactions');
  return db;
}

test('standalone migration repairs missing OIDC storage and can be rerun without data loss', async () => {
  const db = missingStorageDb();
  try {
    await db.execute(`INSERT INTO users(user_id,first_name,last_name,display_name,email,status)
      VALUES('USR-OIDC','Existing','User','Existing User','existing@example.invalid','INVITED')`);
    const before = await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
    assert.equal(Number((await db.execute(OIDC_STORAGE_COLUMNS_SQL)).rows[0]?.n), 0);
    await assert.rejects(() => createOidcTransaction(asClient(db), input), /no such table/);

    db.raw.exec(migration);
    assert.equal(Number((await db.execute(OIDC_STORAGE_COLUMNS_SQL)).rows[0]?.n), 10);
    await createOidcTransaction(asClient(db), input);
    const saved = await db.execute('SELECT * FROM auth_oidc_transactions');
    assert.equal(saved.rows.length, 1);
    assert.equal(saved.rows[0]?.expires_at, '2026-11-02 12:10:00');

    db.raw.exec(migration);
    assert.deepEqual((await db.execute('SELECT * FROM auth_oidc_transactions')).rows, saved.rows);
    assert.deepEqual(
      (
        await db.execute(`SELECT type,name,sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND name <> 'auth_oidc_transactions'
        ORDER BY type,name`)
      ).rows,
      before.rows,
    );
    assert.equal(
      (await db.execute("SELECT email FROM users WHERE user_id='USR-OIDC'")).rows[0]?.email,
      'existing@example.invalid',
    );
  } finally {
    db.close();
  }
});

test('health prerequisite detects partial storage, not just a table with the right name', async () => {
  const db = missingStorageDb();
  try {
    db.raw.exec('CREATE TABLE auth_oidc_transactions(transaction_id TEXT PRIMARY KEY)');
    assert.equal(Number((await db.execute(OIDC_STORAGE_COLUMNS_SQL)).rows[0]?.n), 1);
  } finally {
    db.close();
  }
});

test('migrated storage supports valid one-time consumption and rejects unknown or expired state', async () => {
  const db = missingStorageDb();
  try {
    db.raw.exec(migration);
    const client = asClient(db);
    await createOidcTransaction(client, input);
    assert.equal(await consumeOidcTransaction(client, 'unknown-state', NOW), null);
    assert.deepEqual(await consumeOidcTransaction(client, input.stateHash, NOW), {
      provider: 'GOOGLE',
      purpose: 'SIGN_IN',
      nonceHash: input.nonceHash,
      verifier: input.verifier,
      returnPath: '/app',
    });
    assert.equal(await consumeOidcTransaction(client, input.stateHash, NOW), null);
    await createOidcTransaction(client, { ...input, stateHash: 'expired-state' });
    assert.equal(
      await consumeOidcTransaction(client, 'expired-state', new Date(NOW.getTime() + 10 * 60_000)),
      null,
    );
    assert.equal(
      (
        await db.execute(
          "SELECT consumed_at FROM auth_oidc_transactions WHERE state_hash='expired-state'",
        )
      ).rows[0]?.consumed_at,
      null,
    );
  } finally {
    db.close();
  }
});

test('migrated storage enforces unique state and provider/purpose/expiry constraints', async () => {
  const db = missingStorageDb();
  try {
    db.raw.exec(migration);
    const client = asClient(db);
    await createOidcTransaction(client, input);
    await assert.rejects(() => createOidcTransaction(client, input), /UNIQUE constraint/);
    for (const sql of [
      "UPDATE auth_oidc_transactions SET provider='UNKNOWN'",
      "UPDATE auth_oidc_transactions SET purpose='UNKNOWN'",
      "UPDATE auth_oidc_transactions SET expires_at='2026-11-02 11:59:59'",
    ])
      await assert.rejects(() => db.execute(sql), /CHECK constraint/);
  } finally {
    db.close();
  }
});
