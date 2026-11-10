export const prerender = false;

/**
 * Logout endpoint. Clears the session cookie and redirects to the login screen.
 * Session validation is deliberately handled here: a visitor must still be
 * able to clear an expired or revoked cookie and return to the login screen.
 */
import type { APIRoute } from 'astro';
import { clearSession, readSession } from '@engr/auth/session';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';

export const POST: APIRoute = async ({ request }) => {
  // Match the set cookie: Secure in production (https), off for http development.
  const secure = new URL(request.url).protocol === 'https:';
  try {
    const env = getEngrEnv();
    const session = await readSession(request, env.sessionSecret);
    if (session?.sessionId) {
      const db = await getDb(env);
      await db.execute({
        sql: `UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'logout'
               WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
        args: [new Date().toISOString(), session.sessionId, session.sub],
      });
    }
  } catch (error) {
    // Even if Turso is unavailable, discard this browser's cookie. Log the
    // failed server-side revocation for operators to investigate.
    console.error('[engr.auth.logout] session revocation unavailable', error);
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: '/login',
      'set-cookie': clearSession(secure),
      'cache-control': 'no-store',
    },
  });
};

// A direct browser visit to this form endpoint must not revoke a session.
// The home page sends signed-out visitors on to /login.
export const GET: APIRoute = async () =>
  new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store' } });
