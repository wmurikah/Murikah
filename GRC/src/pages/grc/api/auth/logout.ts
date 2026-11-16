export const prerender = false;

/**
 * Sign out. Deletes the server-side session row so the session cannot be reused,
 * clears the grc cookie, and redirects to the sign-in page. A missing or invalid
 * cookie still clears and redirects, so sign-out is always safe to call.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { readSessionId, clearSessionCookies } from '@grc/auth/session';
import { clearActingCookies } from '@grc/auth/actingOrg';
import { clearRolePreviewCookies } from '@grc/auth/rolePreview';
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
  const headers = new Headers({ location: '/login' });
  for (const cookie of [
    ...clearSessionCookies(secure),
    ...clearActingCookies(secure),
    ...clearRolePreviewCookies(secure),
  ]) {
    headers.append('set-cookie', cookie);
  }
  headers.set('clear-site-data', '"cache", "cookies", "storage"');
  return new Response(null, { status: 303, headers });
};
