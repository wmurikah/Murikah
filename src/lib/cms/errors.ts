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
import { json } from '@/lib/http';

export type CmsErrorCode =
  /** Every authentication failure the browser is allowed to see. */
  | 'invalid_credentials'
  | 'unauthorised'
  | 'rate_limited'
  | 'invalid_request'
  | 'method_not_allowed'
  | 'server_error'
  | 'unavailable';

export interface CmsApiError {
  error: {
    code: CmsErrorCode;
    message: string;
    traceId?: string;
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
