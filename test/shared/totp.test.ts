/**
 * TOTP core. The module under test is a pure leaf (only global WebCrypto), so
 * node strips types and runs it directly. Pinned against the RFC 6238 test
 * vector (SHA1, secret "12345678901234567890" as base32, T=59s -> 287082) and
 * the skew window the MFA step allows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, totpAt, verifyTotp, generateSecret } from '../../src/lib/shared/totp.ts';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"

test('base32Decode decodes the RFC secret to 20 bytes', () => {
  const bytes = base32Decode(RFC_SECRET);
  assert.equal(bytes.length, 20);
  assert.equal(bytes[0], 0x31); // '1'
  assert.equal(bytes[19], 0x30); // '0'
});

test('totpAt matches the RFC 6238 SHA1 vector at T=59', async () => {
  assert.equal(await totpAt(RFC_SECRET, 59), '287082');
});

test('verifyTotp accepts the correct code and rejects a wrong one', async () => {
  assert.equal(await verifyTotp(RFC_SECRET, '287082', 59), true);
  assert.equal(await verifyTotp(RFC_SECRET, '000000', 59), false);
});

test('verifyTotp allows one step of clock skew but not two', async () => {
  // 287082 is valid at counter floor(59/30)=1; it stays valid within +/-1 step.
  assert.equal(await verifyTotp(RFC_SECRET, '287082', 59 + 30), true);
  assert.equal(await verifyTotp(RFC_SECRET, '287082', 59 + 90), false);
});

test('verifyTotp rejects a malformed code without throwing', async () => {
  assert.equal(await verifyTotp(RFC_SECRET, 'abc', 59), false);
  assert.equal(await verifyTotp(RFC_SECRET, '12345', 59), false);
});

test('generateSecret returns a 32-char base32 secret that round-trips', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(s).length, 20);
});
