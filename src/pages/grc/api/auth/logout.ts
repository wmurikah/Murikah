export const prerender = false;

/**
 * Sign out. Deletes the server-side session row so the session cannot be reused,
 * clears the grc cookie, and redirects to the sign-in page. A missing or invalid
 * cookie still clears and redirects, so sign-out is always safe to call.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { readSessionId, clearSession } from '@grc/auth/session';
import { deleteSession } from '@grc/repos/session';

export const POST: APIRoute = async ({ request }) => {
  const secure = new URL(request.url).protocol === 'https:';
  try {
    const env = getGrcEnv();
    const sessionId = await readSessionId(request, env.sessionSecret);
    if (sessionId) {
      const db = await getDb(env);
      await deleteSession(db, sessionId);
    }
  } catch {
    // Even if the delete fails, clear the cookie and sign the user out locally.
  }
  return new Response(null, {
    status: 303,
    headers: { location: '/login', 'set-cookie': clearSession(secure) },
  });
};
