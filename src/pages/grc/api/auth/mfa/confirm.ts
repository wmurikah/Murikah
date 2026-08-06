export const prerender = false;

/**
 * Confirm MFA enrolment (or a method switch): verify a first code against the
 * pending factor, authenticator (RFC 6238 against the pending sealed secret)
 * or email (the hashed one-time code emailed at enrolment), then activate it,
 * keeping only the SHA-256 hashes of the backup codes. Wrong emailed codes
 * count against the challenge and lock it at the cap; a locked or expired
 * challenge asks for a resend. The activation is recorded in
 * security_events. Tagged [grc.auth.mfa]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { verifyTotp } from '@grc/auth/totp';
import { open } from '@grc/auth/secretBox';
import { hashToken } from '@grc/auth/session';
import { checkOtpAttempt, OTP_MAX_ATTEMPTS } from '@grc/auth/emailOtp';
import { getMfaRecord, confirmEnrolment, hashBackupCodes, saveMfaChallenge } from '@grc/repos/mfa';
import { recordSecurityEvent } from '@grc/repos/loginAttempts';

const TAG = '[grc.auth.mfa]';
const PAGE = '/mfa/setup';

function back(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `${PAGE}?error=${encodeURIComponent(message)}` },
  });
}

const GENERIC = 'That code was not valid. Check it and try again.';
const RESEND = 'That code is no longer usable. Send a new code and try again.';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const form = await request.formData();
    const code = String(form.get('code') ?? '').trim();
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');

    const record = await getMfaRecord(db, grc.homeOrganizationId, grc.userId);
    if (!record?.pendingMethod) {
      return back('There is no enrolment waiting to be confirmed.');
    }
    const backupPlain = record.backupPlain
      ? await open(env.sessionSecret, record.backupPlain)
      : null;
    if (!backupPlain) {
      console.error(`${TAG} pending enrolment could not be opened`);
      return back('The enrolment could not be read. Start it again.');
    }

    if (record.pendingMethod === 'totp') {
      const secret = record.pendingSecret
        ? await open(env.sessionSecret, record.pendingSecret)
        : null;
      if (!secret) {
        console.error(`${TAG} pending secret could not be opened`);
        return back('The enrolment could not be read. Start it again.');
      }
      const ok = await verifyTotp(secret, code, Math.floor(Date.now() / 1000));
      if (!ok) return back('That code was not valid. Check the app and try again.');
    } else {
      const check = checkOtpAttempt(record.challenge, await hashToken(code), Date.now());
      if (check === 'wrong') {
        const challenge = record.challenge;
        if (challenge) {
          const attempts = challenge.attempts + 1;
          await saveMfaChallenge(db, grc.homeOrganizationId, grc.userId, {
            ...challenge,
            attempts,
          });
          if (attempts >= OTP_MAX_ATTEMPTS) {
            await recordSecurityEvent(db, {
              eventType: 'MFA_OTP_LOCKED',
              severity: 'warning',
              userId: grc.userId,
              actorEmail: grc.userEmail ?? null,
              ip,
              details: 'The enrolment code was locked after repeated wrong guesses.',
            }).catch(() => undefined);
          }
        }
        return back(GENERIC);
      }
      if (check !== 'ok') return back(RESEND);
    }

    const codes = JSON.parse(backupPlain) as string[];
    await confirmEnrolment(db, grc.homeOrganizationId, grc.userId, await hashBackupCodes(codes));
    await recordSecurityEvent(db, {
      eventType: 'MFA_ENROLLED',
      severity: 'info',
      userId: grc.userId,
      actorEmail: grc.userEmail ?? null,
      ip,
      details:
        record.pendingMethod === 'email'
          ? 'Two-step verification activated with email codes.'
          : 'Two-step verification activated with an authenticator app.',
    });
    return new Response(null, { status: 303, headers: { location: `${PAGE}?done=1` } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back('The enrolment could not be confirmed just now. Please try again.');
  }
};
