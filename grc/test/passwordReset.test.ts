/**
 * The pure pieces of the forgotten-password flow: the reset-password rules
 * (passwordPolicy.ts) and the in-memory rate limiter (resetRateLimit.ts).
 * Both modules are import-free, so node strips types and runs them directly.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkResetPassword, MIN_PASSWORD_LENGTH } from '../../src/lib/grc/auth/passwordPolicy.ts';
import {
  allowResetRequest,
  resetRateLimitState,
  RESET_EMAIL_LIMIT,
  RESET_IP_LIMIT,
  RESET_WINDOW_MS,
} from '../../src/lib/grc/auth/resetRateLimit.ts';

beforeEach(() => resetRateLimitState());

test('the reset rules enforce length and confirmation, nothing else', () => {
  assert.equal(checkResetPassword('short', 'short').ok, false);
  assert.equal(checkResetPassword('a'.repeat(MIN_PASSWORD_LENGTH), 'different-confirm').ok, false);
  assert.equal(
    checkResetPassword('a'.repeat(MIN_PASSWORD_LENGTH), 'a'.repeat(MIN_PASSWORD_LENGTH)).ok,
    true,
  );
});

test('the email window admits the limit and refuses the next request', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < RESET_EMAIL_LIMIT; i++) {
    assert.equal(allowResetRequest('user@example.com', `ip-${i}`, t0 + i), true, `request ${i}`);
  }
  assert.equal(allowResetRequest('user@example.com', 'ip-x', t0 + 10), false);
  // A different address is unaffected.
  assert.equal(allowResetRequest('other@example.com', 'ip-y', t0 + 11), true);
});

test('the email key is case- and whitespace-insensitive', () => {
  const t0 = 2_000_000;
  for (let i = 0; i < RESET_EMAIL_LIMIT; i++) {
    allowResetRequest('User@Example.com', `ip-${i}`, t0 + i);
  }
  assert.equal(allowResetRequest('  user@example.com ', 'ip-x', t0 + 10), false);
});

test('the IP window bounds enumeration across many addresses', () => {
  const t0 = 3_000_000;
  for (let i = 0; i < RESET_IP_LIMIT; i++) {
    assert.equal(allowResetRequest(`probe-${i}@example.com`, '10.0.0.9', t0 + i), true);
  }
  assert.equal(allowResetRequest('probe-next@example.com', '10.0.0.9', t0 + 20), false);
  // A missing IP shares one bucket rather than escaping the limit.
  for (let i = 0; i < RESET_IP_LIMIT; i++) {
    allowResetRequest(`blank-${i}@example.com`, null, t0 + i);
  }
  assert.equal(allowResetRequest('blank-next@example.com', '', t0 + 30), false);
});

test('the window resets after it elapses', () => {
  const t0 = 4_000_000;
  for (let i = 0; i < RESET_EMAIL_LIMIT; i++) {
    allowResetRequest('user@example.com', 'ip-a', t0 + i);
  }
  assert.equal(allowResetRequest('user@example.com', 'ip-a', t0 + 10), false);
  assert.equal(allowResetRequest('user@example.com', 'ip-a', t0 + RESET_WINDOW_MS + 1), true);
});
