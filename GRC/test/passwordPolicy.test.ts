/**
 * New-password rules. The module under test is a pure leaf, so node strips types
 * and runs it directly. These pin the length floor, the "must differ" rule and
 * the confirmation match the change-password endpoint relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { checkNewPassword, MIN_PASSWORD_LENGTH } from '../src/lib/grc/auth/passwordPolicy.ts';

const oldPassword = randomBytes(18).toString('base64url');
const newPassword = randomBytes(18).toString('base64url');
const otherPassword = randomBytes(18).toString('base64url');

test('a long, different, matching password passes', () => {
  const r = checkNewPassword(oldPassword, newPassword, newPassword);
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
});

test('a password shorter than the minimum fails', () => {
  const short = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
  const r = checkNewPassword(oldPassword, short, short);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /at least/);
});

test('exactly the minimum length is allowed', () => {
  const exact = 'x'.repeat(MIN_PASSWORD_LENGTH);
  const r = checkNewPassword(oldPassword, exact, exact);
  assert.equal(r.ok, true);
});

test('the new password may not equal the current one', () => {
  const r = checkNewPassword(oldPassword, oldPassword, oldPassword);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /different/);
});

test('a mismatched confirmation fails', () => {
  const r = checkNewPassword(oldPassword, newPassword, otherPassword);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /do not match/);
});
