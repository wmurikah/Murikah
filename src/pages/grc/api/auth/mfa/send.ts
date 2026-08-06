export const prerender = false;

/**
 * Send (or resend) an email one-time sign-in code, behind the cooldown. Two
 * contexts share it: a half-authorised (mfa=pending) session on the sign-in
 * step whose active method is email, and a signed-in user confirming an
 * email enrolment on the setup screen. The context comes from the cookie's
 * mfa state, so a pending session can never trigger enrolment sends and vice
 * versa. Cooldown-limited (auth/emailOtp.ts); sends are recorded in
 * security_events by the issuer. Tagged [grc.auth.mfa]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { readGrcSessionCookie } from '@grc/auth/session';
import { resolveSession } from '@grc/repos/session';
import { getMfaRecord } from '@grc/repos/mfa';
import { getGrcDeliveryEnv } from '@grc/notify/env';
import { issueEmailOtp } from '@grc/notify/otpMail';

const TAG = '[grc.auth.mfa]';

const back = (page: string, q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${page}?${q}` } });

export const POST: APIRoute = async ({ request }) => {
  try {
    const env = getGrcEnv();
    const cookie = await readGrcSessionCookie(request, env.sessionSecret);
    if (!cookie) return new Response(null, { status: 303, headers: { location: '/login' } });
    const page = cookie.mfa === 'pending' ? '/mfa' : '/mfa/setup';

    const db = await getDb(env);
    const identity = await resolveSession(db, cookie.sessionId);
    if (!identity) return new Response(null, { status: 303, headers: { location: '/login' } });
    const email = identity.userEmail ?? '';
    if (email === '') {
      return back(page, `error=${encodeURIComponent('Your account has no email address.')}`);
    }

    const record = await getMfaRecord(db, identity.homeOrganizationId, identity.userId);
    const eligible =
      cookie.mfa === 'pending'
        ? record?.confirmed === true && record.method === 'email'
        : record?.pendingMethod === 'email';
    if (!record || !eligible) {
      return back(page, `error=${encodeURIComponent('There is no email code to send here.')}`);
    }

    const issued = await issueEmailOtp(
      db,
      getGrcDeliveryEnv(),
      env.sessionSecret,
      {
        organizationId: identity.homeOrganizationId,
        userId: identity.userId,
        email,
        ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for'),
      },
      record,
    );
    if (!issued.ok) {
      if (!issued.cooldown) console.error(`${TAG} code send failed:`, issued.reason);
      return back(page, `error=${encodeURIComponent(issued.reason)}`);
    }
    return back(page, 'sent=1');
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back(
      '/mfa',
      `error=${encodeURIComponent('The code could not be sent just now. Please try again.')}`,
    );
  }
};
