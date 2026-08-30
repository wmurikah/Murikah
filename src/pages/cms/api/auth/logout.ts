/**
 * POST /api/auth/logout on cms.murikah.com.
 *
 * Revokes the session server-side and clears the cookie. Both matter: clearing
 * the cookie alone would leave a live session row that a copied token could
 * still use, which is the difference between signing out and hiding the key.
 *
 * Answers the same way whether or not a session was found. A logout that
 * reported "no such session" would tell an attacker holding a stolen token
 * whether it is still live, and there is nothing a legitimate client does
 * differently.
 *
 * Two callers, two correct answers, chosen by what the client says it accepts.
 * The sign-out control in the shell is a real HTML form, so a browser posting
 * it needs somewhere to land: it gets 303 to the sign-in page. A fetch or a
 * server-to-server client gets 204 and no body. Content negotiation rather than
 * two endpoints, because it is one action either way.
 */
import type { APIRoute } from 'astro';
import { clientIp } from '@/lib/http';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { readSessionCookie, clearSessionCookie, isSecureRequest } from '@/lib/cms/auth/cookie';
import { endSession } from '@/lib/cms/auth/loginFlow';
import { apiError, newTraceId } from '@/lib/cms/errors';
import { LOGIN_PATH } from '@/lib/cms/routes';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const cleared = clearSessionCookie({ secure: isSecureRequest(request) });

  // A browser submitting the sign-out form asks for HTML; a fetch does not.
  const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
  const done = (): Response =>
    wantsHtml
      ? new Response(null, {
          status: 303,
          headers: { 'set-cookie': cleared, location: LOGIN_PATH, 'cache-control': 'no-store' },
        })
      : new Response(null, {
          status: 204,
          headers: { 'set-cookie': cleared, 'cache-control': 'no-store' },
        });

  let env: ReturnType<typeof getCmsEnv>;
  try {
    env = getCmsEnv();
  } catch {
    // Even unconfigured, clear the cookie: the browser should not keep a
    // credential because the server could not reach its database.
    return done();
  }

  try {
    const db = await getDb(env);
    await endSession(db, env.sessionSecret, readSessionCookie(request), {
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
      now: new Date(),
    });
  } catch (error) {
    const traceId = newTraceId();
    console.error(`[cms.logout] ${traceId}`, error);
    return apiError('server_error', 'Sign-out failed.', 500, traceId);
  }

  return done();
};

export const ALL: APIRoute = () => apiError('method_not_allowed', 'Use POST to sign out.', 405);
