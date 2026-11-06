import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp,
} from '../src/lib/engr/auth/mfa.ts';
import { hashOpaqueToken, issueAuthToken, newOpaqueToken } from '../src/lib/engr/auth/tokens.ts';
import { runMigrations } from '../db/migrate.ts';
import {
  isPrivilegedAuthPath,
  mfaPathAllowed,
  requiredMfaStage,
} from '../src/lib/engr/auth/mfaGate.ts';

test('invitation and reset tokens are random and stored as one-way hashes', async () => {
  const first = newOpaqueToken();
  const second = newOpaqueToken();
  assert.notEqual(first, second);
  assert.equal(first.length >= 40, true);
  const hash = await hashOpaqueToken(first);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes(first), false);
});

test('issuing a replacement token revokes the previous unused token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-auth-token-'));
  const db = createClient({ url: `file:${join(directory, 'db.sqlite')}` });
  try {
    await runMigrations(db);
    await db.batch(
      [
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('o1', 'One', 'one')`, args: [] },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email, status)
                VALUES ('u1', 'o1', 'User', 'user@example.com', 'INVITED')`,
          args: [],
        },
      ],
      'write',
    );
    const first = await issueAuthToken(db, {
      orgId: 'o1',
      userId: 'u1',
      purpose: 'INVITE',
      createdBy: null,
      lifetimeMinutes: 60,
    });
    const second = await issueAuthToken(db, {
      orgId: 'o1',
      userId: 'u1',
      purpose: 'INVITE',
      createdBy: null,
      lifetimeMinutes: 60,
    });
    const rows = await db.execute(
      `SELECT token_hash, used_at FROM auth_tokens WHERE user_id = 'u1' ORDER BY created_at, id`,
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows.filter((row) => row.used_at === null).length, 1);
    assert.equal(
      rows.rows.some((row) => String(row.token_hash).includes(first)),
      false,
    );
    assert.equal(
      rows.rows.some((row) => String(row.token_hash).includes(second)),
      false,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('TOTP secrets encrypt with AES-GCM and decrypt only with the correct key', async () => {
  const secret = generateTotpSecret();
  const key = Buffer.alloc(32, 17).toString('base64');
  const wrongKey = Buffer.alloc(32, 18).toString('base64');
  const encrypted = await encryptMfaSecret(secret, key);
  assert.equal(encrypted.ciphertext.includes(secret), false);
  assert.equal(await decryptMfaSecret(encrypted.ciphertext, encrypted.iv, key), secret);
  await assert.rejects(() => decryptMfaSecret(encrypted.ciphertext, encrypted.iv, wrongKey));
});

test('TOTP verifier accepts the RFC SHA-1 vector and rejects malformed codes', async () => {
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(await verifyTotp(rfcSecret, '287082', 59_000), 1);
  assert.equal(await verifyTotp(rfcSecret, 'not-code', 59_000), null);
});

test('recovery codes are displayable once but persist only as normalized hashes', async () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    assert.equal(normalizeRecoveryCode(code).length, 10);
    assert.match(await hashRecoveryCode(code), /^[a-f0-9]{64}$/);
  }
  assert.equal(await hashRecoveryCode(codes[0]), await hashRecoveryCode(codes[0].toLowerCase()));
});

test('MFA gate mandates enrollment and applies ten-minute privileged step-up', () => {
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: false,
      verifiedAt: 0,
      now: 1_000,
      privilegedPath: false,
    }),
    'enroll',
  );
  assert.equal(mfaPathAllowed('enroll', '/api/admin/users'), false);
  assert.equal(mfaPathAllowed('enroll', '/mfa/enroll'), true);
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: true,
      verifiedAt: 1_000,
      now: 1_601,
      privilegedPath: true,
    }),
    'challenge',
  );
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: true,
      verifiedAt: 1_000,
      now: 1_601,
      privilegedPath: false,
    }),
    null,
  );
  assert.equal(isPrivilegedAuthPath('/admin/users'), true);
  assert.equal(isPrivilegedAuthPath('/api/org/switch'), true);
  assert.equal(isPrivilegedAuthPath('/workorders'), false);
});
