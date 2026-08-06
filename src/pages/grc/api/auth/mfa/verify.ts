export const prerender = false;

/**
 * The second-factor step's endpoint. A half-authorised (mfa=pending) session
 * posts a 6-digit code here: from the authenticator app (RFC 6238 against the
 * sealed secret, +/- one step of skew) or from the sign-in email, judged
 * against the stored hashed challenge (single-use, ten-minute expiry, locked
 * after repeated wrong guesses). A backup code works for either method and is
 * consumed on use, recorded in security_events. Success re-issues the cookie
 * fully authorised for the same session row. Failures are recorded in
 * login_attempts (so the ordinary throttle also bounds code guessing) and
 * return to the step with the generic message. Tagged [grc.auth.mfa]; never a
 * blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { readGrcSessionCookie, createSessionCookie, hashToken } from '@grc/auth/session';
import { resolveSession } from '@grc/repos/session';
import { getMfaRecord, consumeBackupCode, saveMfaChallenge } from '@grc/repos/mfa';
import { verifyTotp } from '@grc/auth/totp';
import { open } from '@grc/auth/secretBox';
import { checkOtpAttempt, OTP_MAX_ATTEMPTS } from '@grc/auth/emailOtp';
import { throttleDecision } from '@grc/auth/loginThrottle';
import { failureStreaks, recordLoginAttempt, recordSecurityEvent } from '@grc/repos/loginAttempts';

const TAG = '[grc.auth.mfa]';
const back = (): Response =>
  new Response(null, { status: 303, headers: { location: '/mfa?error=1' } });

export const POST: APIRoute = async ({ request }) => {
  const secure = new URL(request.url).protocol === 'https:';
  try {
    const env = getGrcEnv();
    const cookie = await readGrcSessionCookie(request, env.sessionSecret);
    if (!cookie) return new Response(null, { status: 303, headers: { location: '/login' } });

    const db = await getDb(env);
    const identity = await resolveSession(db, cookie.sessionId);
    if (!identity) return new Response(null, { status: 303, headers: { location: '/login' } });

    const email = (identity.userEmail ?? '').toLowerCase();
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');

    // Code guessing feeds the same durable throttle as password guessing.
    const streaks = await failureStreaks(db, email, ip);
    if (throttleDecision(streaks.byEmail, streaks.byIp).locked) return back();

    const form = await request.formData();
    const code = String(form.get('code') ?? '').trim();
    const backupCode = String(form.get('backup_code') ?? '').trim();

    const record = await getMfaRecord(db, identity.homeOrganizationId, identity.userId);
    if (!record?.confirmed) return back();

    let verified = false;
    if (backupCode !== '') {
      verified = await consumeBackupCode(
        db,
        identity.homeOrganizationId,
        identity.userId,
        backupCode,
      );
      if (verified) {
        await recordSecurityEvent(db, {
          eventType: 'MFA_BACKUP_USED',
          severity: 'warning',
          userId: identity.userId,
          actorEmail: email,
          ip,
          details: 'A backup code was used to pass the second factor.',
        });
      }
    } else if (code !== '' && record.method === 'email') {
      const check = checkOtpAttempt(record.challenge, await hashToken(code), Date.now());
      if (check === 'ok' && record.challenge) {
        // Single-use: the challenge is marked used before the session is
        // promoted, so the same code can never pass twice.
        await saveMfaChallenge(db, identity.homeOrganizationId, identity.userId, {
          ...record.challenge,
          used: true,
        });
        verified = true;
      } else if (check === 'wrong' && record.challenge) {
        const attempts = record.challenge.attempts + 1;
        await saveMfaChallenge(db, identity.homeOrganizationId, identity.userId, {
          ...record.challenge,
          attempts,
        });
        if (attempts >= OTP_MAX_ATTEMPTS) {
          await recordSecurityEvent(db, {
            eventType: 'MFA_OTP_LOCKED',
            severity: 'warning',
            userId: identity.userId,
            actorEmail: email,
            ip,
            details: 'The sign-in code was locked after repeated wrong guesses.',
          }).catch(() => undefined);
        }
      }
    } else if (code !== '') {
      const secret = await open(env.sessionSecret, record.secret);
      if (secret) {
        verified = await verifyTotp(secret, code, Math.floor(Date.now() / 1000));
      } else {
        console.error(`${TAG} sealed secret could not be opened`);
      }
    }

    if (!verified) {
      await recordLoginAttempt(db, {
        email,
        userId: identity.userId,
        organizationId: identity.homeOrganizationId,
        success: false,
        failureReason: 'mfa_failed',
        ip,
        userAgent: request.headers.get('user-agent'),
      });
      return back();
    }

    const promoted = await createSessionCookie(cookie.sessionId, env.sessionSecret, secure, 'ok');
    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': promoted },
    });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back();
  }
};
