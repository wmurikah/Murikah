export const prerender = false;

/**
 * Sign out. Deletes the server-side session row so it cannot be reused, clears
 * the cms cookie, and redirects to the sign-in page. A missing or invalid cookie
 * still clears and redirects, so sign-out is always safe to call.
 */
import type { APIRoute } from 'astro';
import { getCmsEnv } from '@cms/env';
import { getDb } from '@cms/db';
import { readSessionCookie, clearSession } from '@cms/auth/session';
import { deleteSession, resolveSession } from '@cms/repos/session';

export const POST: APIRoute = async ({ request }) => {
  const secure = new URL(request.url).protocol === 'https:';
  let location = '/login';
  try {
    const env = getCmsEnv();
    const cookie = await readSessionCookie(request, env.sessionSecret);
    if (cookie) {
      const db = await getDb(env);
      // Send a customer back to the portal sign-in, staff to the staff sign-in.
      const identity = await resolveSession(db, cookie.sessionId);
      if (identity?.userType === 'CUSTOMER') location = '/portal/login';
      await deleteSession(db, cookie.sessionId);
    }
  } catch {
    // Even if the delete fails, clear the cookie and sign the user out locally.
  }
  return new Response(null, {
    status: 303,
    headers: { location, 'set-cookie': clearSession(secure) },
  });
};
