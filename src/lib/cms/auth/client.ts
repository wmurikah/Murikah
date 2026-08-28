/**
 * The CMS authentication client.
 *
 * The login page talks to this and to nothing else, so a later phase can put a
 * real endpoint behind `submitCredentials` without the page changing. That is
 * the whole point of the seam: the screen already renders every outcome the
 * real service will be able to return, so connecting it is wiring, not a
 * redesign.
 *
 * It now calls the real endpoint. The result type did not have to change to
 * accommodate it, which was the point of shaping it from the database model in
 * the first place: `password_change_required`, `account_locked` and
 * `mfa_required` were all expressible before anything could return them.
 *
 * No token is stored here, or anywhere else in the browser. The session cookie
 * is `HttpOnly`, so JavaScript cannot read it and could not put it in
 * `localStorage` even deliberately. There is no code preventing that because
 * none is possible to write.
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
  | {
      readonly status: 'success';
      readonly user: CmsAuthenticatedUser;
      /**
       * Where the server says this user's session starts. Computed from their
       * permissions on the server, never inferred here: this code has no
       * permissions to inspect and must not guess at one.
       */
      readonly landing: string;
    }
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

/** The sign-in endpoint, root-relative on the CMS host. */
const LOGIN_ENDPOINT = '/api/auth/login';

/**
 * Submit credentials to the API.
 *
 * Never throws: a sign-in form should render an error rather than break, so
 * every failure mode, including the network being gone, comes back as a result
 * the caller can switch on.
 *
 * The three cases section 11 asks to distinguish map like this. A `401` is the
 * server's single generic answer to every credential problem and stays generic
 * here. A `5xx` or a malformed body is the server being unavailable, and may
 * say so, because "this service is down" discloses nothing about any account.
 * A thrown fetch is the network, and may also say so.
 */
export async function submitCredentials(credentials: CmsCredentials): Promise<CmsAuthResult> {
  let response: Response;
  try {
    response = await fetch(LOGIN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Same-origin only. The cookie the server sets is HttpOnly and is stored
      // by the browser, never read by this code.
      credentials: 'same-origin',
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
  } catch {
    return {
      status: 'transport_error',
      message: 'Could not reach the server. Check your connection and try again.',
    };
  }

  if (response.status === 401) return { status: 'invalid_credentials' };

  if (response.status === 429) {
    return {
      status: 'transport_error',
      message: 'Too many sign-in attempts. Wait a moment and try again.',
    };
  }

  if (!response.ok) {
    return {
      status: 'transport_error',
      message: 'Sign-in is temporarily unavailable. Try again shortly.',
    };
  }

  let body: {
    user?: { userId?: string; displayName?: string; email?: string; userType?: CmsUserType };
    mustChangePassword?: boolean;
    landing?: string;
  };
  try {
    body = await response.json();
  } catch {
    return {
      status: 'transport_error',
      message: 'Sign-in is temporarily unavailable. Try again shortly.',
    };
  }

  const user = body.user;
  if (!user?.userId || !user.userType) {
    return {
      status: 'transport_error',
      message: 'Sign-in is temporarily unavailable. Try again shortly.',
    };
  }

  // The password was correct, so this is a distinct state rather than a
  // failure, and the screen must say so rather than pretending sign-in failed.
  if (body.mustChangePassword === true) {
    return { status: 'password_change_required', userId: user.userId };
  }

  return {
    status: 'success',
    user: {
      userId: user.userId,
      displayName: user.displayName ?? '',
      email: user.email ?? credentials.email,
      userType: user.userType,
    },
    // A same-origin, root-relative path or nothing. A destination read from a
    // response and handed to location.assign is an open-redirect if it is
    // allowed to be absolute, and this one never needs to be.
    landing:
      typeof body.landing === 'string' &&
      body.landing.startsWith('/') &&
      !body.landing.startsWith('//')
        ? body.landing
        : user.userType === 'EXTERNAL'
          ? '/portal'
          : '/app',
  };
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
      // No longer reachable from the endpoint; kept so the union stays
      // exhaustive and a caller cannot forget an arm.
      return 'Sign-in is not connected yet.';
  }
}
