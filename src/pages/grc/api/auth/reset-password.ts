export const prerender = false;

/**
 * Redeem a password-reset token (public). Validates the token (exists by hash,
 * not expired, not used, user active), enforces the new-password rules, hashes
 * with the canonical PBKDF2 scheme, and applies the reset atomically: token
 * used, hash written, forced-change flag cleared, history recorded, every
 * session for the user invalidated. A used or expired token gets one generic
 * invalid-link message. Failures are logged tagged [grc.auth.reset], never a
 * blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { hashPassword } from '@grc/auth/password';
import { checkResetPassword } from '@grc/auth/passwordPolicy';
import { findValidResetToken, applyPasswordReset } from '@grc/repos/passwordReset';

const TAG = '[grc.auth.reset]';

const INVALID = 'That reset link is not valid any more. Please request a new one.';

/** Back to the reset form, keeping the token so the user can correct and retry. */
function back(token: string, message: string): Response {
  const suffix = token === '' ? '' : `&token=${encodeURIComponent(token)}`;
  return new Response(null, {
    status: 303,
    headers: { location: `/reset-password?error=${encodeURIComponent(message)}${suffix}` },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const token = String(form.get('token') ?? '').trim();
    const next = String(form.get('new_password') ?? '');
    const confirm = String(form.get('confirm_password') ?? '');
    if (!token) return back('', INVALID);

    const db = await getDb(getGrcEnv());
    const valid = await findValidResetToken(db, token);
    if (!valid) return back('', INVALID);

    const check = checkResetPassword(next, confirm);
    if (!check.ok) return back(token, check.error ?? 'The new password is not valid.');

    const newHash = await hashPassword(next);
    await applyPasswordReset(db, valid, newHash);

    return new Response(null, {
      status: 303,
      headers: { location: '/login?reset=1' },
    });
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(TAG, detail);
    return back('', 'The password could not be reset just now. Please request a new link.');
  }
};
