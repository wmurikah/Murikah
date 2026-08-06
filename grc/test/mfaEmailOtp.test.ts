/**
 * The pure pieces of the email MFA method (Build Prompt 34): the one-time
 * code challenge rules (auth/emailOtp.ts), the extended MFA record with its
 * method, pending enrolment and transitions (auth/mfaRecord.ts), and the
 * dedicated code email (notify/render.ts). Node strips types and runs the
 * modules directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOtpCode,
  newChallenge,
  parseChallenge,
  resendCooldownMs,
  checkOtpAttempt,
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  type EmailOtpChallenge,
} from '../../src/lib/grc/auth/emailOtp.ts';
import {
  parseMfaRecord,
  canStartEnrolment,
  startPendingRecord,
  promoteRecord,
  type MfaRecord,
} from '../../src/lib/grc/auth/mfaRecord.ts';
import { buildOtpEmail } from '../../src/lib/grc/notify/render.ts';

const NOW = 1_754_000_000_000;

test('codes are six digits and vary', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const code = generateOtpCode();
    assert.match(code, /^[0-9]{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 1, 'fifty draws must not all collide');
});

test('a fresh challenge expires in ten minutes and starts unlocked', () => {
  const c = newChallenge('hash-1', NOW);
  assert.equal(c.hash, 'hash-1');
  assert.equal(Date.parse(c.expiresAt) - NOW, OTP_TTL_MS);
  assert.equal(Date.parse(c.sentAt), NOW);
  assert.equal(c.attempts, 0);
  assert.deepEqual(parseChallenge(JSON.parse(JSON.stringify(c))), { ...c, used: false });
  assert.equal(parseChallenge(undefined), undefined);
  assert.equal(parseChallenge({ hash: '' }), undefined);
});

test('the resend cooldown holds for a minute after a send', () => {
  const c = newChallenge('h', NOW);
  assert.equal(resendCooldownMs(c, NOW), OTP_RESEND_COOLDOWN_MS);
  assert.equal(resendCooldownMs(c, NOW + OTP_RESEND_COOLDOWN_MS - 1), 1);
  assert.equal(resendCooldownMs(c, NOW + OTP_RESEND_COOLDOWN_MS), 0);
  assert.equal(resendCooldownMs(undefined, NOW), 0);
});

test('the attempt check enforces single use, expiry and the lock, in that order', () => {
  const c = newChallenge('right', NOW);
  assert.equal(checkOtpAttempt(undefined, 'right', NOW), 'no_challenge');
  assert.equal(checkOtpAttempt(c, 'right', NOW + 1000), 'ok');
  assert.equal(checkOtpAttempt(c, 'wrong', NOW + 1000), 'wrong');
  assert.equal(checkOtpAttempt(c, 'right', NOW + OTP_TTL_MS + 1), 'expired');
  assert.equal(checkOtpAttempt({ ...c, used: true }, 'right', NOW + 1000), 'used');
  const locked: EmailOtpChallenge = { ...c, attempts: OTP_MAX_ATTEMPTS };
  assert.equal(checkOtpAttempt(locked, 'right', NOW + 1000), 'locked');
  assert.equal(checkOtpAttempt({ ...c, used: true }, 'wrong', NOW + 1000), 'used');
});

test('older records parse as the authenticator method', () => {
  const confirmed = parseMfaRecord(
    JSON.stringify({ secret: 'sealed', confirmed: true, backup: ['h1'] }),
  );
  assert.equal(confirmed?.method, 'totp');
  assert.equal(confirmed?.confirmed, true);

  const pending = parseMfaRecord(
    JSON.stringify({ secret: 'sealed', confirmed: false, backup: [], backupPlain: 'codes' }),
  );
  assert.equal(pending?.pendingMethod, 'totp');
  assert.equal(pending?.pendingSecret, 'sealed');
  assert.equal(pending?.confirmed, false);

  assert.equal(parseMfaRecord(JSON.stringify({ secret: '', confirmed: false })), null);
  assert.equal(parseMfaRecord('not json'), null);
  assert.equal(parseMfaRecord(undefined), null);
});

test('enrolment can start fresh or switch methods, never replace the same method', () => {
  assert.equal(canStartEnrolment(null, 'totp'), true);
  assert.equal(canStartEnrolment(null, 'email'), true);

  const activeTotp: MfaRecord = { method: 'totp', secret: 's', confirmed: true, backup: [] };
  assert.equal(canStartEnrolment(activeTotp, 'email'), true, 'switching is self-service');
  assert.equal(canStartEnrolment(activeTotp, 'totp'), false, 'same-method replacement is not');

  const activeEmail: MfaRecord = { method: 'email', secret: '', confirmed: true, backup: [] };
  assert.equal(canStartEnrolment(activeEmail, 'totp'), true);
  assert.equal(canStartEnrolment(activeEmail, 'email'), false);

  const pendingOnly = startPendingRecord(null, 'email', '', 'codes');
  assert.equal(canStartEnrolment(pendingOnly, 'email'), true, 'a pending enrolment is replaceable');
});

test('a switch keeps the active factor until the new method confirms', () => {
  const active: MfaRecord = {
    method: 'totp',
    secret: 'sealed-totp',
    confirmed: true,
    backup: ['h1'],
  };
  const switching = startPendingRecord(active, 'email', '', 'sealed-codes');
  assert.equal(switching.confirmed, true, 'the active factor still stands');
  assert.equal(switching.method, 'totp');
  assert.equal(switching.secret, 'sealed-totp');
  assert.equal(switching.pendingMethod, 'email');
  assert.equal(switching.backupPlain, 'sealed-codes');
  assert.equal(switching.challenge, undefined, 'an old challenge does not carry over');

  const promoted = promoteRecord(switching, ['n1', 'n2']);
  assert.ok(promoted);
  assert.equal(promoted.method, 'email');
  assert.equal(promoted.secret, '', 'the email method keeps no TOTP secret');
  assert.equal(promoted.confirmed, true);
  assert.deepEqual(promoted.backup, ['n1', 'n2']);
  assert.equal(promoted.pendingMethod, undefined);
  assert.equal(promoted.backupPlain, undefined);

  assert.equal(promoteRecord(promoted, ['x']), null, 'nothing pending, nothing to promote');
});

test('the code email carries the code in HTML and text with the expiry copy', () => {
  const mail = buildOtpEmail('042135');
  assert.ok(mail.subject.includes('sign-in code'));
  assert.ok(mail.body.includes('042135'));
  assert.ok(mail.text.includes('042135'));
  assert.ok(mail.body.includes('ten minutes'));
  assert.ok(mail.text.includes('works once'));
});
