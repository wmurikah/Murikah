export const prerender = false;

/**
 * GRC sign-in endpoint. Email is the identity (no organisation slug): the user
 * is resolved by email across the platform and placed in their home
 * organisation. The password is verified with PBKDF2 against the seeded hash, a
 * session row is created in `sessions`, and its signed id is set as the grc
 * cookie. Permissions and the acting organisation are resolved per request by
 * the middleware from the session, so nothing sensitive is cached in the cookie.
 *
 * The whole handler is wrapped so an authentication failure (unknown email, bad
 * password, inactive account) never produces a 500: it returns the generic
 * failure. Any genuine server error is logged with the [grc.auth.login] tag and
 * a stack trace, so the cause is visible in `wrangler tail` rather than a blank
 * 500. The reads use the TURSO_GRC_* and GRC_SESSION_SECRET bindings only, never
 * the engr bindings.
 */
import type { APIRoute } from 'astro';
import { env as workerEnv } from 'cloudflare:workers';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { verifyPassword } from '@grc/auth/password';
import { resolveUserByEmail, touchLastLogin } from '@grc/repos/login';
import { createSession } from '@grc/repos/session';
import { createSessionCookie } from '@grc/auth/session';
import { defaultLandingPath, isAuditeeRole } from '@grc/dashboard/roleNav';
import { hasMyOverdue } from '@grc/repos/dashboard';

const TAG = '[grc.auth.login]';
const REQUIRED_BINDINGS = [
  'TURSO_GRC_DATABASE_URL',
  'TURSO_GRC_AUTH_TOKEN',
  'GRC_SESSION_SECRET',
] as const;

interface Credentials {
  email: string;
  password: string;
}

async function readCredentials(request: Request, wantsJson: boolean): Promise<Credentials> {
  if (wantsJson) {
    const body = (await request.json()) as Record<string, unknown>;
    return { email: String(body.email ?? ''), password: String(body.password ?? '') };
  }
  const form = await request.formData();
  return { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
}

/** An authentication failure: a JSON 401 for API callers, a redirect for the form. */
function invalid(wantsJson: boolean): Response {
  if (wantsJson) {
    return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
}

/** A genuine server error: a JSON 500 for API callers, the generic failure for the form. */
function serverError(wantsJson: boolean): Response {
  if (wantsJson) {
    return new Response(JSON.stringify({ error: 'server_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
}

/** The first required binding that is missing at runtime, or null when all present. */
function missingBinding(): string | null {
  for (const name of REQUIRED_BINDINGS) {
    if (!workerEnv[name]) return name;
  }
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  const wantsJson =
    (request.headers.get('content-type') ?? '').includes('application/json') ||
    (request.headers.get('accept') ?? '').includes('application/json');

  try {
    const missing = missingBinding();
    if (missing) {
      console.error(`${TAG} missing binding ${missing}`);
      return serverError(wantsJson);
    }

    const { email, password } = await readCredentials(request, wantsJson);
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm || !password) return invalid(wantsJson);

    const env = getGrcEnv();
    const db = await getDb(env);

    // The lookup already requires an active user and organisation, so a missing
    // row covers an unknown email and an inactive user or organisation alike.
    const user = await resolveUserByEmail(db, emailNorm);
    if (!user || !user.passwordHash) return invalid(wantsJson);

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return invalid(wantsJson);

    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
    const userAgent = request.headers.get('user-agent');
    const sessionId = await createSession(db, user.userId, { ip, userAgent });

    // Record the sign-in; never fail the login if this update does.
    try {
      await touchLastLogin(db, user.userId);
    } catch (e) {
      console.error(`${TAG} last_login_at update failed`, e);
    }

    const secure = new URL(request.url).protocol === 'https:';
    const cookie = await createSessionCookie(sessionId, env.sessionSecret, secure);

    // Role-based default landing: an auditee lands on their overdue action plans
    // (or their findings), everyone else on the dashboard.
    let hasOverdue = false;
    if (!user.isPlatformOwner && isAuditeeRole(user.roleCode)) {
      hasOverdue = await hasMyOverdue(db, user.organizationId, user.userId);
    }
    const location = defaultLandingPath(user.roleCode, user.isPlatformOwner, hasOverdue);

    return new Response(null, {
      status: 303,
      headers: { location, 'set-cookie': cookie },
    });
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(TAG, detail);
    return serverError(wantsJson);
  }
};
