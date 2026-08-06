export const prerender = false;

/**
 * Start MFA enrolment for the chosen method (Build Prompt 34). The
 * authenticator app path generates a fresh base32 secret and eight backup
 * codes, seals both (auth/secretBox.ts) and stores the pending record; the
 * email path stores a pending email enrolment with sealed backup codes and
 * emails a first 6-digit code through the Graph mailer. A user with a
 * confirmed factor may start a switch to the other method (the active factor
 * keeps working until the new one confirms); replacing the same method's
 * factor stays an administrative reset. Tagged [grc.auth.mfa]; never a blank
 * 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { generateSecret } from '@grc/auth/totp';
import { seal } from '@grc/auth/secretBox';
import { startEnrolment, getMfaRecord, generateBackupCodes, type MfaMethod } from '@grc/repos/mfa';
import { getGrcDeliveryEnv } from '@grc/notify/env';
import { issueEmailOtp } from '@grc/notify/otpMail';

const TAG = '[grc.auth.mfa]';
const PAGE = '/mfa/setup';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const fail = (message: string): Response => back(`error=${encodeURIComponent(message)}`);

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const form = await request.formData().catch(() => new FormData());
    const rawMethod = String(form.get('method') ?? 'totp');
    const method: MfaMethod = rawMethod === 'email' ? 'email' : 'totp';

    if (method === 'email' && !grc.userEmail) {
      return fail('Your account has no email address, so email codes cannot be used.');
    }

    const codes = generateBackupCodes();
    const sealedCodes = await seal(env.sessionSecret, JSON.stringify(codes));
    const sealedSecret = method === 'totp' ? await seal(env.sessionSecret, generateSecret()) : '';

    const started = await startEnrolment(
      db,
      grc.homeOrganizationId,
      grc.userId,
      method,
      sealedSecret,
      sealedCodes,
    );
    if (!started) {
      return fail(
        'This method is already active. You can switch to the other method here; replacing the active one needs an administrator reset.',
      );
    }

    // The email method proves the mailbox by confirming an emailed code, so
    // send the first one now. A failed send keeps the pending enrolment; the
    // setup screen offers a resend.
    if (method === 'email') {
      const record = await getMfaRecord(db, grc.homeOrganizationId, grc.userId);
      if (!record) return fail('The enrolment could not be read. Start it again.');
      const issued = await issueEmailOtp(
        db,
        getGrcDeliveryEnv(),
        env.sessionSecret,
        {
          organizationId: grc.homeOrganizationId,
          userId: grc.userId,
          email: grc.userEmail ?? '',
          ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for'),
        },
        record,
      );
      if (!issued.ok) {
        console.error(`${TAG} enrolment code send failed:`, issued.reason);
        return fail(`The code could not be emailed: ${issued.reason}`);
      }
      return back('sent=1');
    }

    return new Response(null, { status: 303, headers: { location: PAGE } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('Enrolment could not be started just now. Please try again.');
  }
};
