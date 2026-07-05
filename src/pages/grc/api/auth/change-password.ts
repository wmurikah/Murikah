export const prerender = false;

/**
 * Change-password endpoint (authenticated). Verifies the current password with
 * the shared PBKDF2 verifier, enforces the new-password rules, hashes the new
 * value with the shared hasher (the exact canonical scheme the verifier expects,
 * so the next sign-in succeeds), updates the user and clears the forced-change
 * flag, records the previous credential in password_history, rotates the session
 * and audits the change. The handler is wrapped so any failure returns a generic
 * message tagged [grc.auth.change-password], never a blank 500, and no password
 * material is logged or audited.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { verifyPassword, hashPassword } from '@grc/auth/password';
import { checkNewPassword } from '@grc/auth/passwordPolicy';
import { getPasswordState, applyPasswordChange } from '@grc/repos/passwordChange';
import { readSessionId, createSessionCookie } from '@grc/auth/session';
import { createSession, deleteSession } from '@grc/repos/session';

const TAG = '[grc.auth.change-password]';
const PAGE = '/change-password';

/** Return to the form with a single, user-facing reason. */
function back(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `${PAGE}?error=${encodeURIComponent(message)}` },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const secure = new URL(request.url).protocol === 'https:';
  try {
    const form = await request.formData();
    const current = String(form.get('current_password') ?? '');
    const next = String(form.get('new_password') ?? '');
    const confirm = String(form.get('confirm_password') ?? '');
    if (!current || !next || !confirm) return back('Please complete all three fields.');

    const env = getGrcEnv();
    const db = await getDb(env);

    // The current credential, scoped to the acting organisation.
    const state = await getPasswordState(db, grc.userId, grc.organizationId);
    if (!state || !state.passwordHash) {
      console.error(`${TAG} no password on file for the acting user`);
      return back('Your account could not be verified. Please try again.');
    }

    // Verify the current password with the same verifier sign-in uses; a
    // mismatch is a generic message, not a 500.
    const currentOk = await verifyPassword(current, state.passwordHash);
    if (!currentOk) return back('Your current password is incorrect.');

    const check = checkNewPassword(current, next, confirm);
    if (!check.ok) return back(check.error ?? 'The new password is not valid.');

    // Hash with the shared hasher so the stored value is in the canonical scheme
    // the verifier expects; the next sign-in verifies against it.
    const newHash = await hashPassword(next);
    await applyPasswordChange(db, {
      userId: grc.userId,
      organizationId: grc.organizationId,
      previousHash: state.passwordHash,
      newHash,
    });

    // Rotate the session so the credential change takes full effect: a fresh row
    // and cookie, the old row invalidated. This runs after the change is
    // committed, so a rotation hiccup cannot undo the change or lock the user
    // out; the existing cookie simply stays valid until it expires.
    let cookie: string | null = null;
    try {
      const oldSessionId = await readSessionId(request, env.sessionSecret);
      const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
      const userAgent = request.headers.get('user-agent');
      const freshSessionId = await createSession(db, grc.userId, { ip, userAgent });
      cookie = await createSessionCookie(freshSessionId, env.sessionSecret, secure);
      if (oldSessionId) await deleteSession(db, oldSessionId);
    } catch (rotErr) {
      console.error(`${TAG} session rotation failed`, rotErr);
    }

    const headers: Record<string, string> = { location: '/?passwordChanged=1' };
    if (cookie) headers['set-cookie'] = cookie;
    return new Response(null, { status: 303, headers });
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(TAG, detail);
    return back('The password could not be changed just now. Please try again.');
  }
};
