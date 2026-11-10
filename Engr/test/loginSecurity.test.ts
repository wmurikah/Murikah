import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import {
  blockSeconds,
  isLoginBlocked,
  recordLoginBlocked,
  recordLoginFailure,
} from '../src/lib/engr/auth/loginSecurity.ts';
import { SESSION_IDLE_SECONDS } from '../src/lib/engr/auth/trackedSession.ts';

test('login backoff starts at five failures and remains bounded', () => {
  assert.equal(blockSeconds(4), 0);
  assert.equal(blockSeconds(5), 60);
  assert.equal(blockSeconds(6), 120);
  assert.equal(blockSeconds(100), 1800);
  assert.equal(blockSeconds(29, 'IP'), 0);
  assert.equal(blockSeconds(30, 'IP'), 60);
  assert.equal(blockSeconds(31, 'IP'), 120);
});

test('privileged sessions have the shortest application idle lifetime', () => {
  assert.equal(SESSION_IDLE_SECONDS.PRIVILEGED, 15 * 60);
  assert.equal(SESSION_IDLE_SECONDS.RESTRICTED, 10 * 60);
  assert.equal(SESSION_IDLE_SECONDS.STANDARD, 2 * 60 * 60);
});

test('shared IP limits do not block at five failures, and blocked retries do not extend the wait', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-login-limit-'));
  const db = createClient({ url: `file:${join(directory, 'test.db')}` });
  try {
    await db.executeMultiple(`CREATE TABLE auth_login_limits (
      scope TEXT NOT NULL, key_hash TEXT NOT NULL, failure_count INTEGER NOT NULL,
      blocked_until TEXT, first_failure_at TEXT, last_failure_at TEXT,
      PRIMARY KEY (scope, key_hash));
      CREATE TABLE auth_login_events (
        account_hash TEXT, ip_hash TEXT, org_id TEXT, user_id TEXT,
        outcome TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
    const now = new Date();
    const future = new Date(now.getTime() + 60_000).toISOString();
    await db.execute({
      sql: `INSERT INTO auth_login_limits VALUES ('IP', 'shared-ip', 5, ?, ?, ?)`,
      args: [future, now.toISOString(), now.toISOString()],
    });
    assert.equal(await isLoginBlocked(db, 'account', 'shared-ip'), false);

    // Reproduce the live bug: blocked retries inflated this old counter even
    // though the address had fewer real failed-password attempts.
    await db.execute(`UPDATE auth_login_limits SET failure_count = 58 WHERE scope = 'IP'`);
    await db.execute({
      sql: `INSERT INTO auth_login_events (account_hash, ip_hash, outcome, created_at)
            VALUES ('another-account', 'shared-ip', 'FAILURE', ?)`,
      args: [now.toISOString()],
    });
    assert.equal(await isLoginBlocked(db, 'account', 'shared-ip'), false);

    for (let i = 1; i < 30; i++) {
      await db.execute({
        sql: `INSERT INTO auth_login_events (account_hash, ip_hash, outcome, created_at)
              VALUES ('another-account', 'shared-ip', 'FAILURE', ?)`,
        args: [now.toISOString()],
      });
    }
    assert.equal(await isLoginBlocked(db, 'account', 'shared-ip'), true);
    await recordLoginBlocked(db, { accountHash: 'account', ipHash: 'shared-ip' });
    const after = await db.execute(
      `SELECT failure_count, blocked_until FROM auth_login_limits WHERE scope = 'IP'`,
    );
    assert.equal(Number(after.rows[0].failure_count), 58);
    assert.equal(after.rows[0].blocked_until, future);

    await db.execute({
      sql: `INSERT INTO auth_login_limits VALUES ('ACCOUNT', 'account', 40, ?, ?, ?)`,
      args: [
        future,
        new Date(now.getTime() - 60 * 60_000).toISOString(),
        new Date(now.getTime() - 60 * 60_000).toISOString(),
      ],
    });
    assert.equal(await isLoginBlocked(db, 'account', 'other-ip'), false);
    await recordLoginFailure(db, { accountHash: 'account', ipHash: 'other-ip' });
    const reset = await db.execute(
      `SELECT failure_count, blocked_until FROM auth_login_limits WHERE scope = 'ACCOUNT'`,
    );
    assert.equal(Number(reset.rows[0].failure_count), 1);
    assert.equal(reset.rows[0].blocked_until, null);
    for (let i = 0; i < 4; i++) {
      await recordLoginFailure(db, { accountHash: 'account', ipHash: 'other-ip' });
    }
    assert.equal(await isLoginBlocked(db, 'account', 'other-ip'), true);
    assert.equal(await isLoginBlocked(db, 'different-account', 'other-ip'), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
