/**
 * POST /api/auth/logout on cms.murikah.com.
 *
 * Revokes the session server-side and clears the cookie. Both matter: clearing
 * the cookie alone would leave a live session row that a copied token could
 * still use, which is the difference between signing out and hiding the key.
 *
 * Answers 204 whether or not a session was found. A logout that reports
 * "no such session" tells an attacker holding a stolen token whether it is
 * still live, and there is nothing a legitimate client does differently.
 */
import type { APIRoute } from 'astro';
import { clientIp } from '@/lib/http';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { readSessionCookie, clearSessionCookie, isSecureRequest } from '@/lib/cms/auth/cookie';
import { endSession } from '@/lib/cms/auth/loginFlow';
import { apiError, newTraceId } from '@/lib/cms/errors';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const cleared = clearSessionCookie({ secure: isSecureRequest(request) });

  let env: ReturnType<typeof getCmsEnv>;
  try {
    env = getCmsEnv();
  } catch {
    // Even unconfigured, clear the cookie: the browser should not keep a
    // credential because the server could not reach its database.
    return new Response(null, { status: 204, headers: { 'set-cookie': cleared } });
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

  return new Response(null, { status: 204, headers: { 'set-cookie': cleared } });
};

export const ALL: APIRoute = () => apiError('method_not_allowed', 'Use POST to sign out.', 405);
