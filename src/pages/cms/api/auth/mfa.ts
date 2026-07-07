export const prerender = false;

/**
 * The TOTP step. A half-authorised (mfa=pending) session posts its code here;
 * the code is verified against the user's stored base32 secret (RFC 6238), and on
 * success the cookie is re-issued fully authorised (mfa=ok) for the same session,
 * landing on the right surface. A wrong or missing code returns to the step with
 * the generic message. Wrapped and tagged [cms.auth.mfa]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getCmsEnv } from '@cms/env';
import { getDb } from '@cms/db';
import { C, cols } from '@cms/schema/columns';
import { readSessionCookie, createSessionCookie } from '@cms/auth/session';
import { resolveSession } from '@cms/repos/session';
import { verifyTotp } from '@cms/auth/totp';

const TAG = '[cms.auth.mfa]';
const back = (): Response =>
  new Response(null, { status: 303, headers: { location: '/mfa?error=1' } });

async function mfaSecret(
  db: Awaited<ReturnType<typeof getDb>>,
  userType: 'STAFF' | 'CUSTOMER',
  userId: string,
): Promise<string | null> {
  if (userType === 'STAFF') {
    const U = cols(C.users);
    const r = await db.execute({
      sql: `SELECT ${U.mfa_secret} AS secret FROM users WHERE ${U.user_id} = ? LIMIT 1`,
      args: [userId],
    });
    return r.rows[0]?.secret == null ? null : String(r.rows[0].secret);
  }
  const CT = cols(C.contacts);
  const r = await db.execute({
    sql: `SELECT ${CT.mfa_secret} AS secret FROM contacts WHERE ${CT.contact_id} = ? LIMIT 1`,
    args: [userId],
  });
  return r.rows[0]?.secret == null ? null : String(r.rows[0].secret);
}

export const POST: APIRoute = async ({ request }) => {
  const secure = new URL(request.url).protocol === 'https:';
  try {
    const env = getCmsEnv();
    const cookie = await readSessionCookie(request, env.sessionSecret);
    if (!cookie) return new Response(null, { status: 303, headers: { location: '/login' } });

    const db = await getDb(env);
    const identity = await resolveSession(db, cookie.sessionId);
    if (!identity) return new Response(null, { status: 303, headers: { location: '/login' } });

    const form = await request.formData();
    const code = String(form.get('code') ?? '');
    const secret = await mfaSecret(db, identity.userType, identity.userId);
    if (!secret) return back();

    const ok = await verifyTotp(secret, code, Math.floor(Date.now() / 1000));
    if (!ok) return back();

    const promoted = await createSessionCookie(cookie.sessionId, 'ok', env.sessionSecret, secure);
    const location = identity.userType === 'CUSTOMER' ? '/portal' : '/';
    return new Response(null, { status: 303, headers: { location, 'set-cookie': promoted } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back();
  }
};
