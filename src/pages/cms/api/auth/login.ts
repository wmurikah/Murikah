export const prerender = false;

/**
 * Hass CMS sign-in endpoint, for both user types. The surface posts its user_type
 * (STAFF from /login, CUSTOMER from /portal/login); the user is resolved in the
 * matching store (users, or portal-enabled contacts), the password verified with
 * the shared PBKDF2 verifier, and a session created. When MFA is enabled for the
 * user the cookie is set half-authorised (mfa=pending) and the request is sent to
 * the TOTP step; otherwise the session is fully authorised and lands on the right
 * surface. Wrapped so a bad credential returns the one generic message and a
 * genuine error is logged with the [cms.auth.login] tag, never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getCmsEnv } from '@cms/env';
import { getDb } from '@cms/db';
import { verifyPassword } from '@cms/auth/password';
import { resolveByEmail, type UserType } from '@cms/repos/authUsers';
import { createSession } from '@cms/repos/session';
import { createSessionCookie } from '@cms/auth/session';

const TAG = '[cms.auth.login]';

function wantedType(raw: string): UserType {
  return raw === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF';
}

function loginPath(type: UserType): string {
  return type === 'CUSTOMER' ? '/portal/login' : '/login';
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData().catch(() => null);
  const type = wantedType(String(form?.get('user_type') ?? 'STAFF'));
  const fail = (): Response =>
    new Response(null, { status: 303, headers: { location: `${loginPath(type)}?error=1` } });

  try {
    const email = String(form?.get('email') ?? '')
      .trim()
      .toLowerCase();
    const password = String(form?.get('password') ?? '');
    if (!email || !password) return fail();

    const env = getCmsEnv();
    const db = await getDb(env);

    const identity = await resolveByEmail(db, email, type);
    if (!identity) return fail();

    const ok = await verifyPassword(password, identity.passwordHash);
    if (!ok) return fail();

    const sessionId = await createSession(
      db,
      { userType: identity.userType, userId: identity.userId, role: identity.role },
      {
        ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for'),
        userAgent: request.headers.get('user-agent'),
        countryCode: identity.countryCode,
      },
    );

    const secure = new URL(request.url).protocol === 'https:';
    // MFA required for the user: set a half-authorised cookie and go to the TOTP
    // step. Otherwise fully authorise and land on the right surface.
    const needsMfa = identity.mfaEnabled && !!identity.mfaSecret;
    const cookie = await createSessionCookie(
      sessionId,
      needsMfa ? 'pending' : 'ok',
      env.sessionSecret,
      secure,
    );
    const location = needsMfa ? '/mfa' : identity.userType === 'CUSTOMER' ? '/portal' : '/';
    return new Response(null, { status: 303, headers: { location, 'set-cookie': cookie } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail();
  }
};
