import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';
import {
  hashPassword,
  passwordNeedsRehash,
  validateNewPassword,
  validatePasswordSecurity,
  verifyPassword,
} from '../src/lib/engr/auth/password.ts';
import { createSession, readSession, type SessionPayload } from '../src/lib/engr/auth/session.ts';
import { passwordGateDecision } from '../src/lib/engr/auth/passwordGate.ts';

const secret = Buffer.alloc(32, 7).toString('base64');

const payload: SessionPayload = {
  sub: 'user-1',
  org: 'org-1',
  orgSlug: 'affiliate',
  roles: ['ADMIN'],
  perms: ['users.manage'],
  sessionVersion: 4,
};

function requestForCookie(setCookie: string): Request {
  return new Request('https://engr.example.test/', {
    headers: { cookie: setCookie.split(';', 1)[0] },
  });
}

function tokenFromCookie(setCookie: string): string {
  return setCookie.split(';', 1)[0].split('=', 2)[1];
}

test('new password policy supports paste-friendly passphrases and enforces length', () => {
  assert.match(validateNewPassword('too-short') ?? '', /at least 12/);
  assert.match(validateNewPassword(' '.repeat(12)) ?? '', /only spaces/);
  assert.match(validateNewPassword('x'.repeat(129)) ?? '', /no more than 128/);
  assert.equal(validateNewPassword('correct horse battery staple'), null);
});

test('PBKDF2 hashes use the free-Worker-compatible cost', () => {
  assert.equal(passwordNeedsRehash('pbkdf2$10000$c2FsdA==$aGFzaA=='), true);
  assert.equal(passwordNeedsRehash('pbkdf2$60000$c2FsdA==$aGFzaA=='), false);
  assert.equal(passwordNeedsRehash('pbkdf2$600000$c2FsdA==$aGFzaA=='), false);
});

test('breach check uses only the SHA-1 prefix and rejects a matching suffix', async () => {
  let requested = '';
  const password = 'correct horse battery staple';
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const digest = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const error = await validatePasswordSecurity(password, async (input) => {
    requested = String(input);
    return new Response(`${digest.slice(5)}:42\nOTHER:1`, { status: 200 });
  });
  assert.match(requested, new RegExp(`/range/${digest.slice(0, 5)}$`));
  assert.equal(requested.includes(digest.slice(5)), false);
  assert.match(error ?? '', /data breach/);
});

test('password hashes verify the matching value and reject a different value', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^pbkdf2\$60000\$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('incorrect horse battery staple', hash), false);
  assert.equal(hash.includes('correct horse'), false);
});

test('oversized hashes fail before Worker CPU is spent', async () => {
  const existing =
    'pbkdf2$600000$AAECAwQFBgcICQoLDA0ODw==$7xdxRO7JQgy8EJPSqLNEqSvFBtDU7JwCjdGfgyTYweY=';
  const original = crypto.subtle.deriveBits;
  try {
    Object.defineProperty(crypto.subtle, 'deriveBits', {
      configurable: true,
      value: async () => {
        throw new Error('oversized PBKDF2 reached the Worker runtime');
      },
    });
    assert.equal(await verifyPassword('correct horse battery staple', existing), false);
  } finally {
    Object.defineProperty(crypto.subtle, 'deriveBits', { configurable: true, value: original });
  }
});

test('PBKDF2 uses native WebCrypto within the supported Worker limit', async () => {
  const stored = await hashPassword('a unique long passphrase');
  assert.equal(await verifyPassword('a unique long passphrase', stored), true);
});

test('temporary-password sessions are restricted and expire after ten minutes', async () => {
  const setCookie = await createSession(
    { ...payload, roles: [], perms: [], passwordChangeOnly: true },
    secret,
    true,
  );
  assert.match(setCookie, /Max-Age=600/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const claims = decodeJwt(tokenFromCookie(setCookie));
  assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 600);
  const decoded = await readSession(requestForCookie(setCookie), secret);
  assert.equal(decoded?.passwordChangeOnly, true);
  assert.equal(decoded?.sessionVersion, 4);
  assert.deepEqual(decoded?.perms, []);
});

test('MFA enrollment and challenge sessions also expire after ten minutes', async () => {
  for (const authStage of ['mfa-enroll', 'mfa-challenge'] as const) {
    const setCookie = await createSession(
      { ...payload, roles: [], perms: [], authStage },
      secret,
      true,
    );
    assert.match(setCookie, /Max-Age=600/);
    const claims = decodeJwt(tokenFromCookie(setCookie));
    assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 600);
    assert.equal((await readSession(requestForCookie(setCookie), secret))?.authStage, authStage);
  }
});

test('full sessions retain the twelve-hour lifetime and session generation', async () => {
  const setCookie = await createSession(payload, secret, true);
  assert.match(setCookie, /Max-Age=43200/);
  const claims = decodeJwt(tokenFromCookie(setCookie));
  assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 43_200);
  const decoded = await readSession(requestForCookie(setCookie), secret);
  assert.equal(decoded?.passwordChangeOnly, false);
  assert.equal(decoded?.sessionVersion, 4);
  assert.deepEqual(decoded?.perms, ['users.manage']);
});

test('password-change sessions cannot reach application pages or APIs', () => {
  assert.equal(passwordGateDecision(true, true, '/workorders', false), 'redirect');
  assert.equal(passwordGateDecision(true, true, '/api/requests', true), 'forbid');
  assert.equal(passwordGateDecision(true, true, '/change-password', false), 'allow');
  assert.equal(passwordGateDecision(true, true, '/api/auth/change-password', true), 'allow');
  assert.equal(passwordGateDecision(true, true, '/api/auth/logout', true), 'allow');
  assert.equal(passwordGateDecision(false, false, '/workorders', false), 'allow');
});
