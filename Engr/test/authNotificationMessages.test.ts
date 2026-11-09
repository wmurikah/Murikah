import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { fixedClock } from '../src/lib/engr/time.ts';
import { authLink, issueAuthTokenWithMetadata } from '../src/lib/engr/auth/tokens.ts';
import {
  authMessageForDelivery,
  authMessageKeyReady,
  encryptAuthMessage,
  redactUserAuthMessages,
} from '../src/lib/engr/auth/notificationMessages.ts';
import { runDispatch } from '../src/lib/engr/notify/dispatch.ts';
import { listRecentFailed, retryFailed } from '../src/lib/engr/repos/notifications.ts';
import type { DeliveryEnv } from '../src/lib/engr/notify/env.ts';

const key = Buffer.alloc(32, 19).toString('base64');
const wrongKey = Buffer.alloc(32, 20).toString('base64');
const origin = 'https://engr.murikah.com';
const production: DeliveryEnv = {
  mode: 'production',
  at: null,
  email: { apiKey: 'test-key', from: 'Engineering <test@example.com>' },
  authMessageKey: key,
  cronSecret: null,
  webhookSecret: null,
};

async function createUser(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO users (id, org_id, full_name, email, status)
          VALUES (?, 'o1', ?, ?, 'ACTIVE')`,
    args: [id, id, `${id}@example.com`],
  });
}

async function queueEncrypted(
  db: Client,
  id: string,
  userId: string,
  templateKey: 'auth.invitation' | 'auth.password.reset',
  lifetimeMinutes = 60,
): Promise<{ value: string; hash: string; body: string }> {
  const issued = await issueAuthTokenWithMetadata(db, {
    orgId: 'o1',
    userId,
    purpose: templateKey === 'auth.invitation' ? 'INVITE' : 'RESET',
    createdBy: null,
    lifetimeMinutes,
  });
  const clear = `Set your password: ${authLink(origin, issued.value)}`;
  const body = await encryptAuthMessage(
    clear,
    { id, orgId: 'o1', userId, templateKey },
    issued,
    key,
  );
  await db.execute({
    sql: `INSERT INTO notifications
            (id, org_id, channel, recipient_user_id, template_key, subject, body, status)
          VALUES (?, 'o1', 'EMAIL', ?, ?, 'Set password', ?, 'QUEUED')`,
    args: [id, userId, templateKey, body],
  });
  return { value: issued.value, hash: issued.hash, body };
}

async function notification(db: Client, id: string) {
  const result = await db.execute({
    sql: 'SELECT status, body, error FROM notifications WHERE id = ?',
    args: [id],
  });
  return result.rows[0];
}

test('authentication emails stay encrypted through hold, failure and retry, then redact on send', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-auth-message-'));
  const db = createClient({ url: `file:${join(directory, 'test.db')}` });
  const originalFetch = globalThis.fetch;
  let providerStatus = 503;
  const sentBodies: string[] = [];
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(String(JSON.parse(String(init?.body)).text));
    return new Response(JSON.stringify({ id: 'provider-1' }), { status: providerStatus });
  };
  try {
    await runMigrations(db);
    await db.execute("INSERT INTO organisations (id, name, slug) VALUES ('o1', 'One', 'one')");
    await createUser(db, 'u1');
    const reset = await queueEncrypted(db, 'n1', 'u1', 'auth.password.reset');
    assert.equal(authMessageKeyReady(key), true);
    assert.equal(authMessageKeyReady(undefined), false);
    assert.equal(String((await notification(db, 'n1')).body).includes(reset.value), false);
    assert.equal(
      await authMessageForDelivery(
        db,
        reset.body,
        { id: 'n1', orgId: 'o1', userId: 'u1', templateKey: 'auth.password.reset' },
        wrongKey,
        new Date(),
      ),
      null,
    );
    assert.equal(
      await authMessageForDelivery(
        db,
        reset.body,
        { id: 'another-row', orgId: 'o1', userId: 'u1', templateKey: 'auth.password.reset' },
        key,
        new Date(),
      ),
      null,
    );

    const now = fixedClock(new Date());
    await runDispatch(db, { ...production, mode: 'other' }, now, { limit: 20 });
    assert.equal((await notification(db, 'n1')).status, 'QUEUED');
    await runDispatch(db, { ...production, authMessageKey: null }, now, { limit: 20 });
    assert.equal((await notification(db, 'n1')).status, 'QUEUED');
    assert.deepEqual(sentBodies, []);

    await runDispatch(db, production, now, { limit: 20 });
    assert.equal((await notification(db, 'n1')).status, 'FAILED');
    assert.equal((await notification(db, 'n1')).body, reset.body);
    assert.equal(
      (await listRecentFailed(db, 'o1')).find((row) => row.id === 'n1')?.retryable,
      true,
    );
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].includes(reset.value), true);

    assert.equal(await retryFailed(db, 'o1', 'n1'), true);
    assert.equal((await notification(db, 'n1')).status, 'QUEUED');
    providerStatus = 200;
    await runDispatch(db, production, now, { limit: 20 });
    assert.equal((await notification(db, 'n1')).status, 'SENT');
    assert.equal(String((await notification(db, 'n1')).body).includes(reset.value), false);
    assert.equal(await retryFailed(db, 'o1', 'n1'), false);

    await createUser(db, 'u2');
    const invite = await queueEncrypted(db, 'n2', 'u2', 'auth.invitation');
    await runDispatch(db, production, now, { limit: 20 });
    assert.equal((await notification(db, 'n2')).status, 'SENT');
    assert.equal(String((await notification(db, 'n2')).body).includes(invite.value), false);
    assert.equal(sentBodies.at(-1)?.includes(invite.value), true);

    await createUser(db, 'u3');
    const expired = await queueEncrypted(db, 'n3', 'u3', 'auth.password.reset', -1);
    await runDispatch(db, production, now, { limit: 20 });
    assert.equal((await notification(db, 'n3')).status, 'FAILED');
    assert.equal(String((await notification(db, 'n3')).body).includes(expired.value), false);
    assert.equal(await retryFailed(db, 'o1', 'n3'), false);
    assert.equal(
      (await listRecentFailed(db, 'o1')).find((row) => row.id === 'n3')?.retryable,
      false,
    );

    await createUser(db, 'u4');
    const legacy = await issueAuthTokenWithMetadata(db, {
      orgId: 'o1',
      userId: 'u4',
      purpose: 'RESET',
      createdBy: null,
      lifetimeMinutes: 60,
    });
    await db.execute({
      sql: `INSERT INTO notifications
              (id, org_id, channel, recipient_user_id, template_key, body, status)
            VALUES ('n4', 'o1', 'EMAIL', 'u4', 'auth.password.reset', ?, 'QUEUED')`,
      args: [`Legacy link: ${authLink(origin, legacy.value)}`],
    });
    await runDispatch(db, { ...production, mode: 'other' }, now, { limit: 20 });
    assert.equal((await notification(db, 'n4')).status, 'FAILED');
    assert.equal(String((await notification(db, 'n4')).body).includes(legacy.value), false);
    assert.equal(await retryFailed(db, 'o1', 'n4'), false);
    const token = await db.execute({
      sql: 'SELECT used_at FROM auth_tokens WHERE token_hash = ?',
      args: [legacy.hash],
    });
    assert.notEqual(token.rows[0]?.used_at, null);

    await createUser(db, 'u5');
    const used = await queueEncrypted(db, 'n5', 'u5', 'auth.password.reset');
    await db.execute({
      sql: `UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?`,
      args: [new Date().toISOString(), used.hash],
    });
    await runDispatch(db, { ...production, mode: 'other' }, now, { limit: 20 });
    assert.equal((await notification(db, 'n5')).status, 'FAILED');
    assert.equal(String((await notification(db, 'n5')).body).includes(used.value), false);

    await createUser(db, 'u6');
    const superseded = await queueEncrypted(db, 'n6', 'u6', 'auth.invitation');
    await issueAuthTokenWithMetadata(db, {
      orgId: 'o1',
      userId: 'u6',
      purpose: 'INVITE',
      createdBy: null,
      lifetimeMinutes: 60,
    });
    await runDispatch(db, { ...production, mode: 'other' }, now, { limit: 20 });
    assert.equal((await notification(db, 'n6')).status, 'FAILED');
    assert.equal(String((await notification(db, 'n6')).body).includes(superseded.value), false);

    await createUser(db, 'u7');
    const tampered = await queueEncrypted(db, 'n7', 'u7', 'auth.password.reset');
    const cipherAt = tampered.body.lastIndexOf(':') + 5;
    await db.execute({
      sql: `UPDATE notifications SET body = ? WHERE id = 'n7'`,
      args: [
        `${tampered.body.slice(0, cipherAt)}${tampered.body[cipherAt] === 'A' ? 'B' : 'A'}${tampered.body.slice(cipherAt + 1)}`,
      ],
    });
    const beforeTamper = sentBodies.length;
    await runDispatch(db, production, now, { limit: 20 });
    assert.equal((await notification(db, 'n7')).status, 'FAILED');
    assert.equal((await notification(db, 'n7')).body, '[authentication link removed]');
    assert.equal(sentBodies.length, beforeTamper);

    await createUser(db, 'u8');
    const old = await issueAuthTokenWithMetadata(db, {
      orgId: 'o1',
      userId: 'u8',
      purpose: 'RESET',
      createdBy: null,
      lifetimeMinutes: 60,
    });
    await db.execute({
      sql: `INSERT INTO notifications
              (id, org_id, channel, recipient_user_id, template_key, body, status)
            VALUES ('n8-old', 'o1', 'EMAIL', 'u8', 'auth.password.reset', ?, 'QUEUED')`,
      args: [`Legacy link: ${authLink(origin, old.value)}`],
    });
    const fresh = await queueEncrypted(db, 'n8-new', 'u8', 'auth.password.reset');
    await runDispatch(db, { ...production, mode: 'other' }, now, { limit: 20 });
    assert.equal((await notification(db, 'n8-old')).status, 'FAILED');
    assert.equal((await notification(db, 'n8-new')).status, 'QUEUED');
    const freshToken = await db.execute({
      sql: 'SELECT used_at FROM auth_tokens WHERE token_hash = ?',
      args: [fresh.hash],
    });
    assert.equal(freshToken.rows[0]?.used_at, null);

    await createUser(db, 'u9');
    const redeemed = await queueEncrypted(db, 'n9', 'u9', 'auth.password.reset');
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: 'UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?',
        args: [new Date().toISOString(), redeemed.hash],
      });
      await redactUserAuthMessages(tx, 'o1', 'u9');
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    assert.equal((await notification(db, 'n9')).status, 'FAILED');
    assert.equal((await notification(db, 'n9')).body, '[authentication link removed]');
    assert.equal(await retryFailed(db, 'o1', 'n9'), false);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
