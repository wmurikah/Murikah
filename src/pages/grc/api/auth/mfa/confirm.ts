export const prerender = false;

/**
 * Confirm MFA enrolment: verify a first code against the pending sealed
 * secret, then activate the factor, keeping only the SHA-256 hashes of the
 * backup codes. The activation is recorded in security_events. Tagged
 * [grc.auth.mfa]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { verifyTotp } from '@grc/auth/totp';
import { open } from '@grc/auth/secretBox';
import { getMfaRecord, confirmEnrolment, hashBackupCodes } from '@grc/repos/mfa';
import { recordSecurityEvent } from '@grc/repos/loginAttempts';

const TAG = '[grc.auth.mfa]';
const PAGE = '/mfa/setup';

function back(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `${PAGE}?error=${encodeURIComponent(message)}` },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const form = await request.formData();
    const code = String(form.get('code') ?? '').trim();

    const record = await getMfaRecord(db, grc.homeOrganizationId, grc.userId);
    if (!record || record.confirmed) {
      return back('There is no enrolment waiting to be confirmed.');
    }
    const secret = await open(env.sessionSecret, record.secret);
    const backupPlain = record.backupPlain
      ? await open(env.sessionSecret, record.backupPlain)
      : null;
    if (!secret || !backupPlain) {
      console.error(`${TAG} pending enrolment could not be opened`);
      return back('The enrolment could not be read. Start it again.');
    }

    const ok = await verifyTotp(secret, code, Math.floor(Date.now() / 1000));
    if (!ok) return back('That code was not valid. Check the app and try again.');

    const codes = JSON.parse(backupPlain) as string[];
    await confirmEnrolment(db, grc.homeOrganizationId, grc.userId, await hashBackupCodes(codes));
    await recordSecurityEvent(db, {
      eventType: 'MFA_ENROLLED',
      severity: 'info',
      userId: grc.userId,
      actorEmail: grc.userEmail ?? null,
      ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for'),
      details: 'Two-step verification activated by the account holder.',
    });
    return new Response(null, { status: 303, headers: { location: `${PAGE}?done=1` } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back('The enrolment could not be confirmed just now. Please try again.');
  }
};
