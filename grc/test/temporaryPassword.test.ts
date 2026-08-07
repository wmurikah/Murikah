/**
 * The system-generated temporary password (Build Prompt 39). The module under
 * test has no imports, so node strips types and runs it directly. These pin what
 * the credential has to be: unguessable, unambiguous to read back, and never the
 * same twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_CHARS,
} from '../../src/lib/grc/auth/temporaryPassword.ts';

test('a generated password is grouped, long enough and readable', () => {
  const pw = generateTemporaryPassword();
  assert.match(pw, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/, `unexpected shape: ${pw}`);
  assert.equal(pw.replace(/-/g, '').length, TEMPORARY_PASSWORD_CHARS);
  // The characters that are misread when a password is spoken or copied off a
  // screen are deliberately absent from the alphabet.
  for (const ambiguous of ['0', '1', 'I', 'L', 'O']) {
    assert.ok(!pw.includes(ambiguous), `${pw} must not contain ${ambiguous}`);
  }
});

test('the change-password minimum is comfortably cleared', () => {
  // The forced change at first sign-in requires twelve characters; a temporary
  // password shorter than that would be an odd thing to issue.
  assert.ok(generateTemporaryPassword().length >= 12);
});

test('generated passwords do not repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(generateTemporaryPassword());
  assert.equal(seen.size, 500, 'every generated password must be distinct');
});

test('every position varies across draws', () => {
  // A generator that fixed a position (an off-by-one in the group loop, say)
  // would still look random overall; check each slot moves on its own.
  const draws = Array.from({ length: 200 }, () => generateTemporaryPassword().replace(/-/g, ''));
  for (let i = 0; i < TEMPORARY_PASSWORD_CHARS; i++) {
    const distinct = new Set(draws.map((d) => d[i]));
    assert.ok(distinct.size > 5, `position ${i} barely varies (${distinct.size} distinct)`);
  }
});
