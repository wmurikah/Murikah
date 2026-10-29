/**
 * One error shape for every CMS API response.
 *
 * Built on the shared `json` helper in src/lib/http.ts rather than a second
 * response builder, so the CMS endpoints serialise the way the rest of the
 * repository does.
 *
 * The shape is `{ error: { code, message, traceId? } }`. The code is stable and
 * safe for a client to branch on; the message is for a human and is generic
 * wherever the specific reason would tell an attacker something. The trace id
 * is the thread back to the server-side record: it is what a support call
 * quotes, and it is meaningless to anyone without log access, so it discloses
 * nothing on its own.
 */
import { json } from '../http.ts';
import type { FieldError } from '../validation.ts';

export type CmsErrorCode =
  /** Every authentication failure the browser is allowed to see. */
  | 'invalid_credentials'
  | 'unauthorised'
  | 'rate_limited'
  | 'invalid_request'
  | 'method_not_allowed'
  | 'server_error'
  | 'unavailable'
  /**
   * Signed in, and not permitted. Distinct from `unauthorised`, which means not
   * signed in: a client that conflates them retries the sign-in it already
   * completed, and a user is told to do something that will not help.
   */
  | 'forbidden'
  /** The row named in the path does not exist. */
  | 'not_found'
  /** The input was understood and is not acceptable. See `fields`. */
  | 'validation_failed'
  /** The write would break a uniqueness rule the database enforces. */
  | 'conflict';

export interface CmsApiError {
  error: {
    code: CmsErrorCode;
    message: string;
    traceId?: string;
    /**
     * Per-field messages, present only on `validation_failed` and `conflict`.
     *
     * The envelope was `{ code, message }` in Build Prompt 03, where every
     * failure was an authentication failure and naming a field would have been
     * an oracle. Administration is the opposite case: the caller is signed in,
     * authorised, and being told their own typing is wrong, so a message that
     * cannot say which of six inputs is at fault is a worse experience for no
     * security gain. The key is optional, so every Build Prompt 03 response is
     * byte-identical to what it was.
     */
    fields?: FieldError[];
  };
}

/**
 * The single message the browser sees for a failed sign-in, whatever actually
 * went wrong: unknown email, wrong password, inactive user, unverified email,
 * missing credential, locked account, or a credential written under an
 * algorithm this runtime cannot compute. The real reason goes to
 * `login_attempts` and `audit_events`.
 */
export const GENERIC_LOGIN_FAILURE = 'That email address and password do not match.';

/** A short, unguessable id for correlating a response with a server-side log. */
export function newTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function apiError(
  code: CmsErrorCode,
  message: string,
  status: number,
  traceId?: string,
): Response {
  const body: CmsApiError = { error: { code, message, ...(traceId ? { traceId } : {}) } };
  return json(body, status);
}

/**
 * Input the server understood and will not accept, with the reason attached to
 * the field it belongs to.
 *
 * 422 rather than 400: the request was well formed and the server parsed it, so
 * the client has nothing to fix about how it asked, only about what it asked
 * for. A client can therefore branch on the status alone to decide whether to
 * paint field messages or report a protocol failure.
 */
export function validationFailed(fields: FieldError[]): Response {
  const body: CmsApiError = {
    error: {
      code: 'validation_failed',
      message: 'Some of those details need attention.',
      fields,
    },
  };
  return json(body, 422);
}

/**
 * A uniqueness rule the database enforces, reported against its field.
 *
 * Separate from `validationFailed` because the cause is different and the
 * client may want to say so differently: the value is well formed and somebody
 * else already has it. 409 is the status for exactly that.
 */
export function conflict(
  fields: FieldError[],
  message = 'That value is already in use.',
): Response {
  const body: CmsApiError = { error: { code: 'conflict', message, fields } };
  return json(body, 409);
}

/** Signed in, and not permitted to do this. */
export function forbidden(message = 'You do not have permission to do that.'): Response {
  return apiError('forbidden', message, 403);
}

/** Not signed in. */
export function unauthorised(): Response {
  return apiError('unauthorised', 'Sign in to continue.', 401);
}

/** No such row. */
export function notFound(message = 'That record could not be found.'): Response {
  return apiError('not_found', message, 404);
}

/**
 * The login failure, returned identically for every internal cause.
 *
 * Deliberately carries no trace id. A trace id varies per response, and the
 * requirement is that an unknown email and a wrong password produce
 * byte-identical bodies; a per-response id would break that for no benefit,
 * since the server-side record is already keyed by the attempt row.
 */
export function loginFailure(): Response {
  return apiError('invalid_credentials', GENERIC_LOGIN_FAILURE, 401);
}
