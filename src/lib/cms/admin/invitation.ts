/**
 * Invitation tokens.
 *
 * The same shape as the session token in Build Prompt 03: a random value goes
 * to the person, and only its HMAC reaches the database. `token_hash` is UNIQUE
 * on `email_verification_tokens`, and the raw token exists in exactly one
 * place, the link, for exactly as long as the invitation is open.
 *
 * The consequence worth stating: a stolen database gives an attacker the hashes
 * and no way to invert them, and an administrator reading the table cannot
 * impersonate anybody. That is why this file never returns a raw token from a
 * read, never writes one to an audit row, and never puts one in an error.
 *
 * DELIVERY
 * There is no mail sender configured for this product. `RESEND_API_KEY` belongs
 * to the marketing site. So delivery has two behaviours, and which one runs is
 * decided by `invitationLinksVisible()` in ../env.ts and nothing else:
 *
 *   development  the link is returned to the administrator who created the
 *                user, once, in the create response. It is never logged.
 *   otherwise    no link is returned. The invitation is still issued and the
 *                user still exists as INVITED, and the response says plainly
 *                that mail is not configured so an administrator knows the
 *                person cannot yet sign in. Failing closed and saying so beats
 *                creating an unusable account in silence.
 */
import { newSessionToken, hashSessionToken, toDbTimestamp } from '../auth/session.ts';
import { newId } from '../repos/authRecords.ts';

/** Seven days. Long enough for somebody on leave, short enough to expire. */
export const INVITATION_TTL_HOURS = 168;

export interface IssuedInvitation {
  /** The row to write. Carries the hash and never the token. */
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /**
   * The raw token. Present only in the process that created it, never stored,
   * and returned to a caller only where `invitationLinksVisible()` is true.
   */
  readonly rawToken: string;
}

export async function issueInvitation(secret: string, now: Date): Promise<IssuedInvitation> {
  const rawToken = newSessionToken();
  const expires = new Date(now.getTime() + INVITATION_TTL_HOURS * 3600 * 1000);
  return {
    tokenId: newId('EVT'),
    tokenHash: await hashSessionToken(rawToken, secret),
    issuedAt: toDbTimestamp(now),
    // CHECK(expires_at >= issued_at); a positive TTL satisfies it by
    // construction, and the constraint stays as the backstop.
    expiresAt: toDbTimestamp(expires),
    rawToken,
  };
}

/** The link a person follows. Root-relative on the CMS host; see section 0b. */
export function invitationPath(rawToken: string): string {
  return `/invitation/${encodeURIComponent(rawToken)}`;
}

/**
 * What the create response may say about delivery.
 *
 * A discriminated union rather than an optional string, so a caller cannot
 * accidentally render an absent link as the empty string and leave an
 * administrator thinking the invitation went out.
 */
export type InvitationDelivery =
  | { readonly kind: 'link'; readonly path: string }
  | { readonly kind: 'not_configured'; readonly message: string };

export const MAIL_NOT_CONFIGURED =
  'The invitation was created, and there is no mail sender configured for this product, so it has not been sent. This user cannot sign in until an administrator delivers their invitation.';

export function describeDelivery(rawToken: string, linksVisible: boolean): InvitationDelivery {
  return linksVisible
    ? { kind: 'link', path: invitationPath(rawToken) }
    : { kind: 'not_configured', message: MAIL_NOT_CONFIGURED };
}
