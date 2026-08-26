/**
 * The CMS authentication client.
 *
 * The login page talks to this and to nothing else, so a later phase can put a
 * real endpoint behind `submitCredentials` without the page changing. That is
 * the whole point of the seam: the screen already renders every outcome the
 * real service will be able to return, so connecting it is wiring, not a
 * redesign.
 *
 * This phase implements no authentication. `submitCredentials` performs no
 * network call, reads no secret, opens no database connection and imports
 * nothing. It returns `not_implemented`, and the page renders that as a server
 * error. There is no fake success anywhere in this file, and there is no code
 * path that can produce one.
 *
 * The result shape is taken from the database model rather than invented, so it
 * does not need rewriting when the service arrives:
 *
 *   auth_credentials  must_change_password  -> 'password_change_required'
 *                     failed_attempts, locked_until -> 'account_locked'
 *   mfa_methods       method_type, enabled  -> 'mfa_required' with the methods
 *   users             user_type INTERNAL | EXTERNAL -> carried on success, so
 *                     the caller can route staff and portal customers apart
 *   login_attempts    exists to record failures; the client never decides what
 *                     is recorded, the service does
 *
 * One rule the UI must not break: an invalid email and an invalid password are
 * the same answer. `invalid_credentials` carries no field, because telling a
 * caller which half was wrong turns the login form into an account enumerator.
 */

/** Which surface a signed-in user belongs to. Mirrors users.user_type. */
export type CmsUserType = 'INTERNAL' | 'EXTERNAL';

/** Mirrors mfa_methods.method_type. Extend only when the database does. */
export type CmsMfaMethodType = 'TOTP' | 'EMAIL' | 'SMS';

/** An enabled second factor offered to the user, from mfa_methods. */
export interface CmsMfaOption {
  readonly methodType: CmsMfaMethodType;
  /** A masked hint, for example a partial number. Never the full destination. */
  readonly hint?: string;
}

export interface CmsCredentials {
  readonly email: string;
  readonly password: string;
}

/** The signed-in identity, once a session exists. */
export interface CmsAuthenticatedUser {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly userType: CmsUserType;
}

/**
 * Every outcome the service can return, as a discriminated union on `status`.
 * A caller that switches on `status` and handles each arm cannot forget one,
 * because TypeScript will not let it.
 */
export type CmsAuthResult =
  /** Credentials accepted and a session exists. */
  | { readonly status: 'success'; readonly user: CmsAuthenticatedUser }
  /**
   * Email or password wrong. Deliberately carries no detail: which of the two
   * was wrong is not the caller's business and must never reach the screen.
   */
  | { readonly status: 'invalid_credentials' }
  /**
   * Too many failures. auth_credentials.locked_until, when the service chooses
   * to disclose it; absent when it would rather not.
   */
  | { readonly status: 'account_locked'; readonly lockedUntil?: string }
  /** auth_credentials.must_change_password is set. Nothing else may proceed. */
  | { readonly status: 'password_change_required'; readonly userId: string }
  /** A second factor is enabled. The challenge continues on the MFA step. */
  | {
      readonly status: 'mfa_required';
      readonly challengeId: string;
      readonly methods: readonly CmsMfaOption[];
    }
  /** The request never got an answer: offline, timeout, 5xx, malformed body. */
  | { readonly status: 'transport_error'; readonly message: string }
  /** This phase. No service is connected yet. */
  | { readonly status: 'not_implemented' };

/**
 * The single message the screen shows for a failed sign-in. One string for both
 * halves of the credential, by design.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'That email address and password do not match.';

/**
 * Submit credentials. Returns a result; never throws, because a login form
 * should render an error rather than break, and never resolves to a success in
 * this phase.
 *
 * The parameter is read only for its type. No value from it leaves this
 * function: nothing is logged, stored, or sent anywhere.
 */
export async function submitCredentials(_credentials: CmsCredentials): Promise<CmsAuthResult> {
  return { status: 'not_implemented' };
}

/**
 * The message a screen shows for a result. Kept beside the result type so a new
 * arm cannot be added without deciding what the user is told, and so the login
 * page holds no copy of its own for outcomes it did not invent.
 */
export function authResultMessage(result: CmsAuthResult): string | null {
  switch (result.status) {
    case 'success':
    case 'mfa_required':
    case 'password_change_required':
      return null;
    case 'invalid_credentials':
      return INVALID_CREDENTIALS_MESSAGE;
    case 'account_locked':
      return 'This account is locked after too many sign-in attempts. Contact your administrator.';
    case 'transport_error':
      return result.message;
    case 'not_implemented':
      return 'Sign-in is not connected yet. This release is the interface only.';
  }
}
