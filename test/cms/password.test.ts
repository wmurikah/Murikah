/**
 * The CMS credential module.
 *
 * A pure leaf: it uses only global WebCrypto, which Node 22 provides, so node
 * strips the types and runs it directly, the same way grc/test/passwordScheme
 * tests Engineering Rhythm's hasher.
 *
 * These assertions are the security properties the phase rests on, written so
 * that a later change that weakens one fails the suite rather than passing
 * review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  isPbkdf2Hash,
  timingSafeEqual,
  dummyVerify,
  PBKDF2_ITERATIONS,
  PASSWORD_ALGORITHM_PBKDF2,
} from '../../src/lib/cms/auth/password.ts';

test('the work factor is at least the 210,000 iterations this phase requires', () => {
  assert.ok(
    PBKDF2_ITERATIONS >= 210_000,
    `iterations must be >= 210000, found ${PBKDF2_ITERATIONS}`,
  );
});

test('a hash is self-describing: scheme, iterations, salt and derived key', async () => {
  const stored = await hashPassword('a correct horse battery staple');
  const [scheme, iterations, salt, key] = stored.split('$');
  assert.equal(scheme, 'pbkdf2-sha256');
  assert.equal(Number(iterations), PBKDF2_ITERATIONS);
  // 16-byte salt and 32-byte key, base64 encoded.
  assert.equal(Buffer.from(salt ?? '', 'base64').length, 16);
  assert.equal(Buffer.from(key ?? '', 'base64').length, 32);
  assert.ok(isPbkdf2Hash(stored));
});

test('the same password hashes differently every time (per-credential salt)', async () => {
  const a = await hashPassword('same password');
  const b = await hashPassword('same password');
  assert.notEqual(a, b, 'two hashes of one password must differ, or the salt is not random');
  assert.deepEqual(await verifyPassword('same password', a, 'PBKDF2'), { ok: true });
  assert.deepEqual(await verifyPassword('same password', b, 'PBKDF2'), { ok: true });
});

test('the correct password verifies and a wrong one does not', async () => {
  const stored = await hashPassword('correct');
  assert.deepEqual(await verifyPassword('correct', stored, 'PBKDF2'), { ok: true });
  assert.deepEqual(await verifyPassword('wrong', stored, 'PBKDF2'), {
    ok: false,
    reason: 'mismatch',
  });
});

test('the plaintext never appears inside the stored string', async () => {
  const secret = 'Nyayo-Highway-1978';
  const stored = await hashPassword(secret);
  assert.ok(!stored.includes(secret));
});

test('verification dispatches on the stored algorithm, not on the string alone', async () => {
  const stored = await hashPassword('correct');
  // The right hash under the wrong declared algorithm must not verify: the
  // database column is the authority on how a credential was written.
  assert.deepEqual(await verifyPassword('correct', stored, 'ARGON2ID'), {
    ok: false,
    reason: 'unsupported_algorithm',
  });
  assert.deepEqual(await verifyPassword('correct', stored, 'BCRYPT'), {
    ok: false,
    reason: 'unsupported_algorithm',
  });
});

test('the seeded DEMO_DISABLED placeholders can never verify', async () => {
  // The seed writes deliberately unusable credentials of this shape. No user
  // may sign in until the bootstrap command has rewritten one.
  const seeded = '$argon2id$DEMO_DISABLED$placeholder-not-a-real-hash';
  for (const attempt of ['', 'password', 'DEMO_DISABLED', seeded]) {
    const result = await verifyPassword(attempt, seeded, 'ARGON2ID');
    assert.equal(result.ok, false);
  }
});

test('a malformed stored value fails closed rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'pbkdf2-sha256$', 'pbkdf2-sha256$0$aa$bb', '$$$$']) {
    const result = await verifyPassword('anything', bad, 'PBKDF2');
    assert.equal(result.ok, false, `"${bad}" must not verify`);
  }
});

test('a credential written at a lower iteration count still verifies', async () => {
  // The migration path the format exists for: verification reads the iteration
  // count from the stored string, not from the module constant.
  const legacy = 'pbkdf2-sha256$120000$MTIzNDU2Nzg5MDEyMzQ1Ng==$'; // salt only, key added below
  const salt = Buffer.from('MTIzNDU2Nzg5MDEyMzQ1Ng==', 'base64');
  const { pbkdf2Sync } = await import('node:crypto');
  const key = pbkdf2Sync('legacy password', salt, 120_000, 32, 'sha256').toString('base64');
  const stored = legacy + key;
  assert.deepEqual(await verifyPassword('legacy password', stored, 'PBKDF2'), { ok: true });
  // ...and is reported as due for a rehash, because it is below current cost.
  assert.equal(needsRehash(stored, 'PBKDF2'), true);
});

test('a current credential is not flagged for rehash', async () => {
  const stored = await hashPassword('current');
  assert.equal(needsRehash(stored, PASSWORD_ALGORITHM_PBKDF2), false);
});

test('timingSafeEqual is correct on length and content', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('dummyVerify costs about the same as a real verification', async () => {
  // The timing guard for an unknown email is only worth having if the two paths
  // are genuinely comparable. A generous band, because CI machines are noisy.
  const stored = await hashPassword('timing');
  const t0 = performance.now();
  await verifyPassword('timing', stored, 'PBKDF2');
  const real = performance.now() - t0;
  const t1 = performance.now();
  await dummyVerify();
  const dummy = performance.now() - t1;
  const ratio = dummy / real;
  assert.ok(ratio > 0.5 && ratio < 2, `dummy/real cost ratio was ${ratio.toFixed(2)}`);
});
