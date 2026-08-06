export const prerender = false;

/**
 * Request a password-reset link (public). The response is always the same
 * neutral redirect, whether or not the address exists, so the endpoint never
 * discloses account existence. For an active user within the limits, a
 * single-use hashed token is issued (password_reset_tokens) and the link is
 * dispatched through the ordinary send queue; the raw token exists only inside
 * that link. Rate-limited per email and per IP in isolate memory, with a
 * durable per-user cap on recent token rows as the backstop. Failures are
 * logged tagged [grc.auth.reset] and still answer neutrally, never a 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { resolveUserByEmail } from '@grc/repos/login';
import {
  issueResetToken,
  countRecentResetRequests,
  RESET_REQUESTS_PER_HOUR,
} from '@grc/repos/passwordReset';
import { allowResetRequest } from '@grc/auth/resetRateLimit';
import { queueNotification } from '@grc/notify/queue';
import { passwordResetLink } from '@grc/notify/links';

const TAG = '[grc.auth.reset]';

/** The one answer this endpoint gives: neutral, identical in every case. */
function neutral(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: '/forgot-password?sent=1' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const email = String(form.get('email') ?? '')
      .trim()
      .toLowerCase();
    if (!email) return neutral();

    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
    if (!allowResetRequest(email, ip, Date.now())) {
      console.error(`${TAG} rate limit reached for a reset request`);
      return neutral();
    }

    const db = await getDb(getGrcEnv());
    const user = await resolveUserByEmail(db, email);
    if (!user) return neutral();

    // Durable backstop, independent of isolate memory: cap the token rows a
    // user can accrue in an hour.
    if ((await countRecentResetRequests(db, user.userId)) >= RESET_REQUESTS_PER_HOUR) {
      console.error(`${TAG} per-user reset cap reached`);
      return neutral();
    }

    const raw = await issueResetToken(db, user.userId, ip);
    await queueNotification(db, user.organizationId, {
      type: 'PASSWORD_RESET',
      recipient: { userId: user.userId, email, name: user.userName ?? '' },
      data: { link: passwordResetLink(raw) },
      relatedEntityType: 'user',
      relatedEntityId: user.userId,
    });
    return neutral();
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(TAG, detail);
    return neutral();
  }
};
