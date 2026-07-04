export const prerender = false;

/**
 * GRC sign-in endpoint. Email is the identity (no organisation slug): the user
 * is resolved by email across the platform and placed in their home
 * organisation. The password is verified with PBKDF2 against the seeded hash, a
 * session row is created in `sessions`, and its signed id is set as the grc
 * cookie. Any failure returns the same generic redirect, so it never reveals
 * whether the email or the password was wrong. Permissions and the acting
 * organisation are resolved per request by the middleware from the session, so
 * nothing sensitive is cached in the cookie.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { verifyPassword } from '@grc/auth/password';
import { resolveUserByEmail } from '@grc/repos/login';
import { createSession } from '@grc/repos/session';
import { createSessionCookie } from '@grc/auth/session';

interface Credentials {
  email: string;
  password: string;
}

async function readCredentials(request: Request): Promise<Credentials> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    return { email: String(body.email ?? ''), password: String(body.password ?? '') };
  }
  const form = await request.formData();
  return { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
}

// The audit system's status values are matched leniently: a sign-in is refused
// only for an explicitly inactive account, so an unexpected active-status label
// never locks a valid user out. See grc/docs/schema-assumptions.md.
const INACTIVE = new Set(['INACTIVE', 'DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED']);
const isInactive = (status: string): boolean => INACTIVE.has(status.trim().toUpperCase());

function invalid(): Response {
  return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
}

export const POST: APIRoute = async ({ request }) => {
  const { email, password } = await readCredentials(request);
  const emailNorm = email.trim().toLowerCase();
  if (!emailNorm || !password) return invalid();

  const env = getGrcEnv();
  const db = await getDb(env);

  const user = await resolveUserByEmail(db, emailNorm);
  if (!user || !user.passwordHash) return invalid();
  if (isInactive(user.status) || isInactive(user.organizationStatus)) return invalid();

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return invalid();

  const sessionId = await createSession(db, user.userId);
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createSessionCookie(sessionId, env.sessionSecret, secure);

  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': cookie },
  });
};
