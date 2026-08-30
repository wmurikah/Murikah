/**
 * Session tokens, the cookie, and sign-in input validation.
 *
 * All three are pure leaves over global WebCrypto, so node runs them directly.
 * The assertions here are the ones that matter if someone later "simplifies"
 * the session model: that the database never holds the cookie value, that the
 * hash is keyed, and that the cookie carries every flag it is supposed to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newSessionToken,
  hashSessionToken,
  sessionWindow,
  toDbTimestamp,
  isExpired,
  SESSION_TTL_SECONDS,
} from '../../src/lib/cms/auth/session.ts';
import {
  SESSION_COOKIE_NAME,
  serialiseSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  isSecureRequest,
} from '../../src/lib/cms/auth/cookie.ts';
import { parseLoginInput, normaliseEmail } from '../../src/lib/cms/auth/loginInput.ts';

const SECRET = 'a-test-only-session-secret-not-a-real-one';

test('a token is 256 bits, URL-safe, and unique per call', () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'must be URL-safe base64 with no padding');
  assert.equal(Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 32);
});

test('the stored hash is never the cookie value', async () => {
  const token = newSessionToken();
  const stored = await hashSessionToken(token, SECRET);
  assert.notEqual(stored, token);
  assert.ok(!stored.includes(token));
  assert.ok(!token.includes(stored));
});

test('the hash is keyed: a different secret gives a different hash', async () => {
  const token = newSessionToken();
  const withKey = await hashSessionToken(token, SECRET);
  const withOther = await hashSessionToken(token, 'a different secret');
  assert.notEqual(
    withKey,
    withOther,
    'the same token under two secrets must differ, or the secret is unused',
  );
});

test('the hash is deterministic, so a lookup is one indexed match', async () => {
  const token = newSessionToken();
  assert.equal(await hashSessionToken(token, SECRET), await hashSessionToken(token, SECRET));
});

test('the session window satisfies the schema CHECK(expires_at >= issued_at)', () => {
  const now = new Date('2026-08-26T09:15:30.500Z');
  const window = sessionWindow(now);
  assert.equal(window.issuedAt, '2026-08-26 09:15:30');
  assert.equal(window.expiresAt, '2026-08-26 17:15:30');
  assert.ok(window.expiresAt >= window.issuedAt);
  assert.equal(window.maxAge, SESSION_TTL_SECONDS);
});

test('timestamps are TEXT in the format the schema uses, and sort correctly', () => {
  assert.equal(toDbTimestamp(new Date('2026-01-02T03:04:05Z')), '2026-01-02 03:04:05');
  // String comparison must order the same way time does, which is what the
  // lazy-expiry check relies on.
  assert.ok(
    toDbTimestamp(new Date('2026-01-02T03:04:05Z')) <
      toDbTimestamp(new Date('2026-01-02T03:04:06Z')),
  );
});

test('lazy expiry compares correctly on both sides of the boundary', () => {
  const now = new Date('2026-08-26T12:00:00Z');
  assert.equal(isExpired('2026-08-26 11:59:59', now), true);
  assert.equal(isExpired('2026-08-26 12:00:01', now), false);
});

test('the cookie carries HttpOnly, SameSite, Path and an explicit expiry', () => {
  const header = serialiseSessionCookie('token-value', { secure: true, maxAge: 28800 });
  assert.ok(header.startsWith(`${SESSION_COOKIE_NAME}=token-value`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=28800/);
  assert.match(header, /Secure/);
});

test('Secure is omitted on plain http, so local development still works', () => {
  const header = serialiseSessionCookie('t', { secure: false, maxAge: 60 });
  assert.ok(!/;\s*Secure/.test(header));
  assert.match(header, /HttpOnly/);
});

test('the clear cookie matches the attributes of the cookie it replaces', () => {
  const header = clearSessionCookie({ secure: true });
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);
  assert.match(header, /Max-Age=0/);
  assert.match(header, /Expires=Thu, 01 Jan 1970/);
});

test('the cookie is read by name and ignores its neighbours', () => {
  const request = (cookie: string) =>
    new Request('https://cms.murikah.com/', { headers: { cookie } });
  assert.equal(readSessionCookie(request('cms_session=abc123')), 'abc123');
  assert.equal(readSessionCookie(request('other=1; cms_session=abc123; third=3')), 'abc123');
  assert.equal(readSessionCookie(request('malformed; cms_session=abc123')), 'abc123');
  assert.equal(readSessionCookie(request('other=1')), null);
  assert.equal(readSessionCookie(request('cms_session=')), null);
  assert.equal(readSessionCookie(new Request('https://cms.murikah.com/')), null);
});

test('a cookie named like ours but not ours is not mistaken for it', () => {
  const request = new Request('https://cms.murikah.com/', {
    headers: { cookie: 'not_cms_session=nope; cms_session_extra=nope' },
  });
  assert.equal(readSessionCookie(request), null);
});

test('the Secure flag follows the forwarded scheme, not the rewritten URL', () => {
  const https = new Request('http://internal/cms/api/auth/login', {
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(isSecureRequest(https), true);
  const http = new Request('http://internal/cms/api/auth/login', {
    headers: { 'x-forwarded-proto': 'http' },
  });
  assert.equal(isSecureRequest(http), false);
});

test('email is normalised for lookup and for the recorded attempt', () => {
  assert.equal(
    normaliseEmail('  Catherine.Mwangi@HassPetroleum.com '),
    'catherine.mwangi@hasspetroleum.com',
  );
});

test('sign-in input is validated before any database call', () => {
  assert.equal(parseLoginInput({ email: 'a@b.co', password: 'x' }).ok, true);
  for (const bad of [
    null,
    'a string',
    {},
    { email: 'a@b.co' },
    { password: 'x' },
    { email: 123, password: 'x' },
    { email: 'a@b.co', password: 123 },
    { email: '   ', password: 'x' },
    { email: 'not-an-email', password: 'x' },
    { email: 'a@b.co', password: '' },
    { email: 'a'.repeat(250) + '@b.co', password: 'x' },
    { email: 'a@b.co', password: 'x'.repeat(1025) },
  ]) {
    assert.equal(parseLoginInput(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('a rejected input reports an internal reason, never a browser message', () => {
  const result = parseLoginInput({ email: 'nope', password: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'email_malformed');
});
