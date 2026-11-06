export const prerender = false;

/**
 * Logout endpoint. Clears the session cookie and redirects to the login screen.
 * Guarded by the middleware, so only a signed-in user reaches it.
 */
import type { APIRoute } from 'astro';
import { clearSession, readSession } from '@engr/auth/session';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';

export const POST: APIRoute = async ({ request }) => {
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
  // Match the set cookie: Secure in production (https), off for http development.
  const secure = new URL(request.url).protocol === 'https:';
  return new Response(null, {
    status: 303,
    headers: { location: '/login', 'set-cookie': clearSession(secure) },
  });
};
