import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';
import {
  hashPassword,
  validateNewPassword,
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

test('password hashes verify the matching value and reject a different value', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('incorrect horse battery staple', hash), false);
  assert.equal(hash.includes('correct horse'), false);
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
