export const prerender = false;

/**
 * Start MFA enrolment: generate a fresh base32 secret and eight backup codes,
 * seal both with the worker secret (auth/secretBox.ts) and store the pending
 * record; the setup screen then shows the QR and the codes. Refused once a
 * confirmed factor exists (replacing it is an administrative reset). Tagged
 * [grc.auth.mfa]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { generateSecret } from '@grc/auth/totp';
import { seal } from '@grc/auth/secretBox';
import { startEnrolment, generateBackupCodes } from '@grc/repos/mfa';

const TAG = '[grc.auth.mfa]';
const PAGE = '/mfa/setup';

export const POST: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const secret = generateSecret();
    const codes = generateBackupCodes();
    const started = await startEnrolment(
      db,
      grc.homeOrganizationId,
      grc.userId,
      await seal(env.sessionSecret, secret),
      await seal(env.sessionSecret, JSON.stringify(codes)),
    );
    if (!started) {
      return new Response(null, {
        status: 303,
        headers: {
          location: `${PAGE}?error=${encodeURIComponent('Two-step verification is already active. Ask your administrator to reset it.')}`,
        },
      });
    }
    return new Response(null, { status: 303, headers: { location: PAGE } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return new Response(null, {
      status: 303,
      headers: {
        location: `${PAGE}?error=${encodeURIComponent('Enrolment could not be started just now. Please try again.')}`,
      },
    });
  }
};
