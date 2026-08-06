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
import { throttleDecision } from '@grc/auth/loginThrottle';
import { failureStreaks, recordLoginAttempt, recordSecurityEvent } from '@grc/repos/loginAttempts';
import { ensureMfaRecord } from '@grc/repos/mfa';
import { getGrcDeliveryEnv } from '@grc/notify/env';
import { issueEmailOtp } from '@grc/notify/otpMail';
import { GRC_MFA_PATH } from '@grc/routing';

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
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
    const userAgent = request.headers.get('user-agent');

    // Durable throttle from login_attempts: a failure streak inside the window
    // locks the email or the IP temporarily. The answer stays the generic
    // failure so the throttle never becomes an account-existence oracle.
    const streaks = await failureStreaks(db, emailNorm, ip);
    const throttle = throttleDecision(streaks.byEmail, streaks.byIp);
    if (throttle.locked) {
      await recordLoginAttempt(db, {
        email: emailNorm,
        userId: null,
        organizationId: null,
        success: false,
        failureReason: 'locked_out',
        ip,
        userAgent,
      });
      await recordSecurityEvent(db, {
        eventType: 'LOGIN_LOCKOUT',
        severity: 'warning',
        userId: null,
        actorEmail: emailNorm,
        ip,
        details: `Sign-in throttled: too many recent failures for this ${throttle.reason}.`,
      });
      return invalid(wantsJson);
    }

    // The lookup already requires an active user and organisation, so a missing
    // row covers an unknown email and an inactive user or organisation alike.
    const user = await resolveUserByEmail(db, emailNorm);
    if (!user || !user.passwordHash) {
      await recordLoginAttempt(db, {
        email: emailNorm,
        userId: null,
        organizationId: null,
        success: false,
        failureReason: 'unknown_email',
        ip,
        userAgent,
      });
      return invalid(wantsJson);
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await recordLoginAttempt(db, {
        email: emailNorm,
        userId: user.userId,
        organizationId: user.organizationId,
        success: false,
        failureReason: 'bad_password',
        ip,
        userAgent,
      });
      return invalid(wantsJson);
    }

    await recordLoginAttempt(db, {
      email: emailNorm,
      userId: user.userId,
      organizationId: user.organizationId,
      success: true,
      failureReason: null,
      ip,
      userAgent,
    });

    const sessionId = await createSession(db, user.userId, { ip, userAgent });

    // Record the sign-in; never fail the login if this update does.
    try {
      await touchLastLogin(db, user.userId);
    } catch (e) {
      console.error(`${TAG} last_login_at update failed`, e);
    }

    const secure = new URL(request.url).protocol === 'https:';

    // Two-step verification is universal (Build Prompt 37): every sign-in
    // gets a half-authorised session (cookie mfa=pending) that only the
    // verification step accepts; no role is exempt, the platform owner
    // included. Email codes are the automatic default, so the record is
    // provisioned here on first sign-in with no enrolment step; an admin who
    // switched to the authenticator app verifies with the app instead. When
    // the method is email the sign-in code is issued and sent now
    // (cooldown-limited); a failed send still lands on the step, which
    // offers a resend and takes a backup code. The role-based landing
    // happens after verification (mfa/verify.ts).
    const mfaRecord = await ensureMfaRecord(
      db,
      user.organizationId,
      user.userId,
      env.sessionSecret,
    );
    let stepQuery = '';
    if (mfaRecord.method === 'email') {
      const issued = await issueEmailOtp(
        db,
        getGrcDeliveryEnv(),
        env.sessionSecret,
        {
          organizationId: user.organizationId,
          userId: user.userId,
          email: emailNorm,
          ip,
        },
        mfaRecord,
      );
      if (issued.ok) {
        stepQuery = '?sent=1';
      } else if (!issued.cooldown) {
        console.error(`${TAG} sign-in code send failed:`, issued.reason);
        stepQuery = '?senderror=1';
      }
    }
    const pendingCookie = await createSessionCookie(
      sessionId,
      env.sessionSecret,
      secure,
      'pending',
    );
    return new Response(null, {
      status: 303,
      headers: { location: `${GRC_MFA_PATH}${stepQuery}`, 'set-cookie': pendingCookie },
    });
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(TAG, detail);
    return serverError(wantsJson);
  }
};
