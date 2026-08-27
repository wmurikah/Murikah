/**
 * The one place a repository result becomes an HTTP response.
 *
 * Written once rather than in each of the eleven endpoints, because the mapping
 * from "the write did not happen" to a status code is the part a reader will
 * check, and eleven copies of it is eleven chances for one of them to answer
 * 200 on a failure.
 *
 * The statuses, and why:
 *   409 conflict           a uniqueness rule; the value is well formed and taken
 *   422 validation_failed  the input is understood and not acceptable
 *   404 not_found          the row named in the path is not there
 *   403 forbidden          signed in, not permitted
 *   401 unauthorised       not signed in
 */
import { json } from '../../http.ts';
import type { FieldError } from '../../validation.ts';
import { conflict, notFound, validationFailed, apiError, newTraceId } from '../errors.ts';
import type { WriteResult } from '../repos/organisationAdmin.ts';

/** A successful read or write. `201` on a create, `200` otherwise. */
export function ok(body: unknown, status = 200): Response {
  const response = json(body, status);
  // Master data belongs to a signed-in administrator and is never shared cache
  // material. The middleware already stamps this on any response where it
  // resolved a principal; setting it here as well means an endpoint reachable
  // some other way cannot quietly become cacheable.
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** The refusal half of a WriteResult, as a response. */
export function failure(result: Extract<WriteResult<unknown>, { ok: false }>): Response {
  switch (result.kind) {
    case 'conflict':
      return conflict(result.fields);
    case 'invalid_reference':
      return validationFailed(result.fields);
    case 'not_found':
      return notFound();
  }
}

export function invalid(errors: FieldError[]): Response {
  return validationFailed(errors);
}

/**
 * An unexpected throw.
 *
 * The trace id goes to the client, the cause goes to the log. A stack trace
 * must never reach a browser, and an error message from a database driver can
 * name a table, a column and sometimes a value.
 */
export function serverError(tag: string, error: unknown): Response {
  const traceId = newTraceId();
  console.error(`[cms.${tag}] ${traceId}`, error);
  return apiError('server_error', 'That could not be completed.', 500, traceId);
}

/** Anything but the verbs an endpoint implements. */
export function methodNotAllowed(allowed: string): Response {
  return apiError('method_not_allowed', `Use ${allowed}.`, 405);
}

/** A JSON body, or null when the request did not carry one. */
export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
