/**
 * Password scheme alignment.
 *
 * The GRC verifier reuses Engineering Rhythm's shared PBKDF2 implementation:
 * src/lib/grc/auth/password.ts re-exports hashPassword and wraps verifyPassword
 * from '@engr/auth/password', so both products call one function and cannot
 * drift. This suite exercises that shared module directly (imported by relative
 * path so node can strip its types and run it), which is the exact code the GRC
 * login path runs.
 *
 * The hashes seeded in hassaudit use the scheme
 *   pbkdf2$<iterations>$<saltBase64>$<hashBase64>
 * with PBKDF2/HMAC-SHA-256, an iteration count read from field two, a 16-byte
 * salt base64-decoded to raw bytes, a 32-byte (256-bit) derived key, a UTF-8
 * password and standard base64 with padding. These tests build such a value by
 * hand, independently of the production hasher, and prove the verifier accepts
 * the right password, rejects the wrong one, is bound to SHA-256 rather than
 * SHA-512, honours the stored iteration count (100000, not the hasher default),
 * and fails safe on malformed input. The trailing-whitespace case documents
 * exactly why the GRC wrapper trims the stored value before parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/lib/engr/auth/password.ts';

const enc = new TextEncoder();

/** Standard base64 with padding, matching the seed and reset scripts. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Build a stored `pbkdf2$iterations$salt$hash` value the way the seed and reset
 * scripts do: a 16-byte random salt, PBKDF2 over the UTF-8 password, a 32-byte
 * (256-bit) derived key, standard base64. The digest is a parameter so a test
 * can build a deliberately wrong SHA-512 value to prove the verifier rejects it.
 */
async function makeStoredHash(
  password: string,
  iterations: number,
  hash: 'SHA-256' | 'SHA-512' = 'SHA-256',
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash },
    keyMaterial,
    256,
  );
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

test('a pbkdf2$100000 hash verifies with the right password and fails with the wrong one', async () => {
  const stored = await makeStoredHash('Temp-Passw0rd!', 100_000);
  const parts = stored.split('$');
  assert.equal(parts.length, 4, 'four dollar-separated fields');
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(parts[1], '100000');
  assert.equal(await verifyPassword('Temp-Passw0rd!', stored), true);
  assert.equal(await verifyPassword('wrong-password', stored), false);
});

test('the iteration count is read from the stored field, not assumed', async () => {
  // 100000 differs from the hasher default, so a match here proves the verifier
  // takes the iteration count from field two rather than a hardcoded constant.
  const stored = await makeStoredHash('correct horse battery', 100_000);
  assert.ok(stored.startsWith('pbkdf2$100000$'));
  assert.equal(await verifyPassword('correct horse battery', stored), true);
});

test('the verifier is bound to SHA-256, so a SHA-512 derived hash never matches', async () => {
  const wrongDigest = await makeStoredHash('same-password', 100_000, 'SHA-512');
  assert.equal(await verifyPassword('same-password', wrongDigest), false);
});

test('hashPassword round-trips through verifyPassword', async () => {
  const stored = await hashPassword('S3cret-value');
  assert.ok(stored.startsWith('pbkdf2$'));
  assert.equal(await verifyPassword('S3cret-value', stored), true);
  assert.equal(await verifyPassword('S3cret-valuE', stored), false);
});

test('leading whitespace breaks verification until the stored value is trimmed', async () => {
  // This is precisely the hardening the GRC wrapper adds:
  // verifyPassword(plain, stored.trim()). A stray leading space or newline on
  // the users.password_hash column shifts the scheme label so it no longer
  // equals 'pbkdf2', and a correct password would wrongly fail. (A trailing
  // newline is tolerated because base64 decoding ignores whitespace, but the
  // trim covers both ends regardless.)
  const stored = await makeStoredHash('boundary-case', 100_000);
  assert.equal(await verifyPassword('boundary-case', `\n${stored}`), false);
  assert.equal(await verifyPassword('boundary-case', `  ${stored}\n`.trim()), true);
});

test('malformed or empty stored values fail safe without throwing', async () => {
  const bad = [
    '',
    'not-a-hash',
    'pbkdf2$100000$onlythree',
    'bcrypt$100000$c2FsdA==$aGFzaA==',
    'pbkdf2$notanumber$c2FsdA==$aGFzaA==',
  ];
  for (const value of bad) {
    assert.equal(await verifyPassword('whatever', value), false, value);
  }
});
