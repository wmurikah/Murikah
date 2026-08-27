/**
 * Rate limits on the writes a signed-in user can repeat.
 *
 * Sign-in has been limited since the authentication phase. What was still
 * open is everything behind it: a portal user can raise a case, reply and
 * answer a survey as fast as a script can post, and an internal user can
 * push workbook after workbook at the Upload Centre. None of that is an
 * authorisation failure, so no guard was ever going to catch it.
 *
 * THE EXISTING HELPER, NOT A NEW ONE. `src/lib/rate-limit.ts` already backs
 * the sign-in limit; this is a caller of it with a key scheme, not a second
 * limiter with its own semantics. It needs no new binding: the helper reads
 * the CACHE namespace the worker already has and returns "allow" when the
 * binding is absent, which is the documented behaviour and what makes this
 * safe to add without touching wrangler.jsonc.
 *
 * THE SUBJECT IS THE USER, NOT THE ADDRESS. Two colleagues at one customer
 * share an office address, and limiting by address would let one of them
 * exhaust the other's allowance. The address is in the key as well, so a
 * single stolen session cannot be spread across a botnet to multiply it.
 *
 * The numbers are deliberately generous. A limit a real person can reach by
 * working normally is a limit that will be removed within a week, and then
 * there is none at all.
 */
import { rateLimit } from '../../rate-limit.ts';
import { clientIp } from '../../http.ts';
import { apiError } from '../errors.ts';

export interface ThrottleRule {
  /** Appears in the key, so one bucket cannot spend another's allowance. */
  readonly bucket: string;
  readonly limit: number;
  readonly windowSeconds: number;
  /** What the person is told. Never a number they could tune against. */
  readonly message: string;
}

export const PORTAL_THROTTLES = {
  /** Raising a request. Ten in an hour is far more than a real customer needs. */
  raiseCase: {
    bucket: 'portal-case',
    limit: 10,
    windowSeconds: 3600,
    message: 'You have raised several requests just now. Please try again in a little while.',
  },
  /** Replying. Higher, because a conversation is a conversation. */
  reply: {
    bucket: 'portal-reply',
    limit: 40,
    windowSeconds: 3600,
    message: 'That is a lot of replies at once. Please try again in a little while.',
  },
  /** Answering a survey. The UNIQUE constraint already allows one per
   *  invitation, so this only blunts a script hunting for invitation ids. */
  survey: {
    bucket: 'portal-survey',
    limit: 20,
    windowSeconds: 3600,
    message: 'Please try again in a little while.',
  },
  /** Uploading a workbook. Internal, and a genuine burst is a few files. */
  upload: {
    bucket: 'cms-upload',
    limit: 30,
    windowSeconds: 3600,
    message: 'Too many uploads at once. Please try again in a little while.',
  },
} as const satisfies Record<string, ThrottleRule>;

/**
 * Returns a 429 response when the caller has spent their allowance, and null
 * when they have not. Null means carry on, so a caller that forgets to check
 * the result would still be readable as wrong.
 */
export async function throttle(
  request: Request,
  rule: ThrottleRule,
  userId: string,
): Promise<Response | null> {
  // `cloudflare:workers` is imported here rather than at the top of the file
  // so that the rule table above can be read by a test running under plain
  // node, where that specifier does not resolve. Nothing else changes: the
  // module is resolved once by the worker and cached from then on.
  const { env } = await import('cloudflare:workers');
  const key = `${rule.bucket}:${userId}:${clientIp(request)}`;
  const result = await rateLimit(env.CACHE, key, rule.limit, rule.windowSeconds);
  return result.ok ? null : apiError('rate_limited', rule.message, 429);
}
