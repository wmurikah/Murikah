/**
 * POST /api/auth/login on cms.murikah.com.
 *
 * The file lives at src/pages/cms/api/auth/login.ts, not src/pages/api/auth/,
 * because the worker rewrites a cms-host request to the internal /cms path
 * before Astro routes it: a file at the repository's api/ root would be the
 * marketing site's endpoint. `toCmsPath('/api/auth/login')` returns
 * '/cms/api/auth/login', which is the file below.
 *
 * A thin shell. The flow itself is in @cms/auth/loginFlow, so it can be tested
 * against a throwaway database without the worker runtime.
 */
import type { APIRoute } from 'astro';
import { env as workerEnv } from 'cloudflare:workers';
import { json, clientIp } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { parseLoginInput, MAX_BODY_BYTES } from '@/lib/cms/auth/loginInput';
import { attemptLogin } from '@/lib/cms/auth/loginFlow';
import { serialiseSessionCookie, isSecureRequest } from '@/lib/cms/auth/cookie';
import { apiError, loginFailure, newTraceId } from '@/lib/cms/errors';
import { homeFor } from '@/lib/cms/routes';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent');

  // Bound the body before parsing it. An oversized payload is refused on the
  // header alone where the client declares one, so a large body never has to be
  // read into the isolate.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return apiError('invalid_request', 'That request was too large.', 413);
  }

  // A shared limiter in front of the credential check, so a guessing attack is
  // slowed before it reaches PBKDF2 rather than after. Degrades to allow when
  // the KV binding is absent, which is the documented behaviour of the helper.
  const limit = await rateLimit(workerEnv.CACHE, `cms-login:${ip}`, 20, 300);
  if (!limit.ok) {
    return apiError('rate_limited', 'Too many sign-in attempts. Try again shortly.', 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('invalid_request', 'That request could not be read.', 400);
  }

  const parsed = parseLoginInput(body);
  if (!parsed.ok) {
    // A malformed body is answered with the same generic failure as a bad
    // credential. Telling a caller that their email was the wrong shape is a
    // small oracle, and there is no legitimate client that needs to be told.
    return loginFailure();
  }

  let env: ReturnType<typeof getCmsEnv>;
  try {
    env = getCmsEnv();
  } catch {
    return apiError('unavailable', 'Sign-in is unavailable.', 503, newTraceId());
  }

  const db = await getDb(env);
  const ctx = { ip, userAgent, now: new Date() };

  let outcome;
  try {
    outcome = await attemptLogin(db, env.sessionSecret, parsed.value, ctx);
  } catch (error) {
    // A trace id goes to the client, the cause goes to the log. A stack trace
    // must never reach a browser.
    const traceId = newTraceId();
    console.error(`[cms.login] ${traceId}`, error);
    return apiError('server_error', 'Sign-in is temporarily unavailable.', 500, traceId);
  }

  if (outcome.kind === 'failure') return loginFailure();

  const cookie = serialiseSessionCookie(outcome.rawToken, {
    secure: isSecureRequest(request),
    maxAge: outcome.maxAge,
  });

  // The response names its fields. Nothing is spread from a database row, so a
  // new column cannot arrive in a body by accident.
  const response = json(
    {
      user: {
        userId: outcome.identity.userId,
        displayName: outcome.identity.displayName,
        email: outcome.identity.email,
        userType: outcome.identity.userType,
      },
      // A distinct state, not a leak: the password was correct, and Build
      // Prompt 02's client interface already expresses this outcome.
      mustChangePassword: outcome.mustChangePassword,
      // WHERE TO GO NEXT, DECIDED HERE. The browser is told a destination
      // rather than working one out, because the decision is a permission
      // question and the browser holds no permissions: the response carries a
      // user type and nothing else, by design. Deciding it here also keeps one
      // answer for the three ways in, the sign-in form, the host root and the
      // middleware's redirect of a signed-in visitor, so they cannot drift.
      landing: homeFor(outcome.identity.userType, outcome.identity.permissions),
    },
    200,
  );
  response.headers.append('set-cookie', cookie);
  // The body names the user and the header carries their credential. The
  // middleware stamps no-store on every response it resolves a principal for,
  // and this request has no cookie yet, so the one response that establishes
  // the session has to say so itself.
  response.headers.set('cache-control', 'no-store');
  return response;
};

/** Anything but POST, answered without touching the database. */
export const ALL: APIRoute = () => apiError('method_not_allowed', 'Use POST to sign in.', 405);
