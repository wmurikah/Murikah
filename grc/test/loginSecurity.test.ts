/**
 * The pure pieces of Build Prompt 25: the throttle decision, the MFA role
 * rule, the session liveness rules, the sealed box and the otpauth URI. All
 * import-free (secretBox and totp use only the WebCrypto global), so node
 * strips types and runs them directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  throttleDecision,
  windowStartIso,
  EMAIL_MAX_FAILURES,
  IP_MAX_FAILURES,
  THROTTLE_WINDOW_MINUTES,
} from '../../src/lib/grc/auth/loginThrottle.ts';
import { mfaRequiredForRole } from '../../src/lib/grc/auth/mfaPolicy.ts';
import {
  sessionLiveness,
  SESSION_IDLE_SECONDS,
  SESSION_TOUCH_INTERVAL_SECONDS,
} from '../../src/lib/grc/auth/sessionRules.ts';
import { seal, open } from '../../src/lib/grc/auth/secretBox.ts';
import { otpauthUrl } from '../../src/lib/grc/auth/otpauth.ts';
import { totpAt, verifyTotp } from '../../src/lib/cms/auth/totp.ts';

const SECRET_B64 = Buffer.from('a-32-byte-secret-for-unit-tests!').toString('base64');

test('the throttle locks on the email streak first, then the IP streak', () => {
  assert.deepEqual(throttleDecision(0, 0), { locked: false, reason: null });
  assert.deepEqual(throttleDecision(EMAIL_MAX_FAILURES - 1, 0), { locked: false, reason: null });
  assert.deepEqual(throttleDecision(EMAIL_MAX_FAILURES, 0), { locked: true, reason: 'email' });
  assert.deepEqual(throttleDecision(0, IP_MAX_FAILURES), { locked: true, reason: 'ip' });
  const start = Date.parse(windowStartIso(1_000_000_000_000));
  assert.equal(1_000_000_000_000 - start, THROTTLE_WINDOW_MINUTES * 60 * 1000);
});

test('the MFA rule defaults to SUPER_ADMIN and honours ALL, NONE and lists', () => {
  assert.equal(mfaRequiredForRole('SUPER_ADMIN', undefined), true);
  assert.equal(mfaRequiredForRole('AUDITOR', undefined), false);
  assert.equal(mfaRequiredForRole('AUDITOR', ''), false);
  assert.equal(mfaRequiredForRole('JUNIOR_STAFF', 'ALL'), true);
  assert.equal(mfaRequiredForRole('SUPER_ADMIN', 'NONE'), false);
  assert.equal(mfaRequiredForRole('HEAD_OF_AUDIT', 'SUPER_ADMIN, HEAD_OF_AUDIT'), true);
  assert.equal(mfaRequiredForRole('AUDITOR', 'SUPER_ADMIN, HEAD_OF_AUDIT'), false);
  assert.equal(mfaRequiredForRole('auditor', 'AUDITOR'), true); // case-insensitive
});

test('session liveness: absolute expiry, idle window, and the touch throttle', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const iso = (offsetSeconds: number) => new Date(now + offsetSeconds * 1000).toISOString();
  // Expired absolutely.
  assert.deepEqual(sessionLiveness(iso(-1), iso(-10), now), {
    alive: false,
    reason: 'expired',
    shouldTouch: false,
  });
  // Idle beyond the window, though the absolute expiry is fine.
  assert.deepEqual(sessionLiveness(iso(3600), iso(-(SESSION_IDLE_SECONDS + 60)), now), {
    alive: false,
    reason: 'idle',
    shouldTouch: false,
  });
  // Active and recently stamped: alive, no write.
  assert.deepEqual(sessionLiveness(iso(3600), iso(-30), now), {
    alive: true,
    reason: null,
    shouldTouch: false,
  });
  // Active but the stamp is stale: alive, refresh it.
  const stale = sessionLiveness(iso(3600), iso(-(SESSION_TOUCH_INTERVAL_SECONDS + 5)), now);
  assert.deepEqual(stale, { alive: true, reason: null, shouldTouch: true });
  // A legacy row with no last_seen_at falls back to the absolute expiry.
  assert.deepEqual(sessionLiveness(iso(3600), null, now), {
    alive: true,
    reason: null,
    shouldTouch: true,
  });
});

test('the sealed box round-trips and rejects tampering', async () => {
  const sealed = await seal(SECRET_B64, 'JBSWY3DPEHPK3PXP');
  assert.notEqual(sealed, 'JBSWY3DPEHPK3PXP');
  assert.equal(await open(SECRET_B64, sealed), 'JBSWY3DPEHPK3PXP');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.equal(await open(SECRET_B64, tampered), null);
  assert.equal(await open(SECRET_B64, 'not-a-box'), null);
});

test('the otpauth URI carries the issuer, account and standard parameters', () => {
  const url = otpauthUrl('user@example.com', 'JBSWY3DPEHPK3PXP');
  assert.ok(url.startsWith('otpauth://totp/'));
  assert.ok(url.includes('user%40example.com'));
  assert.ok(url.includes('secret=JBSWY3DPEHPK3PXP'));
  assert.ok(url.includes('issuer=Assurance%20OS'));
  assert.ok(url.includes('digits=6'));
});

test('the re-exported TOTP core verifies its own codes with skew', async () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const at = 1_754_400_000;
  const code = await totpAt(secret, at);
  assert.equal(await verifyTotp(secret, code, at), true);
  assert.equal(await verifyTotp(secret, code, at + 29), true); // one step of skew
  assert.equal(await verifyTotp(secret, '000000', at), code === '000000');
});
