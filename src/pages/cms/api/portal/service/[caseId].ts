/**
 * GET and POST /api/portal/helpdesk/{caseId} on cms.murikah.com.
 *
 * GET returns the case with its correspondence. An INTERNAL communication is
 * excluded in SQL, so it is not in this response body at all.
 *
 * POST adds the customer's reply. Where the case was waiting on them, the
 * reply emits the phase 15 domain event and the SLA engine decides what
 * resuming means.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { portalCase } from '../../../../../lib/cms/repos/portalData.ts';
import { replyToPortalCase } from '../../../../../lib/cms/repos/portalWrites.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';
import { throttle, PORTAL_THROTTLES } from '../../../../../lib/cms/portal/throttle.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  try {
    const record = await portalCase(connection.db, auth.scope, context.params.caseId ?? '');
    return record === null ? notFound('That request could not be found.') : ok({ case: record });
  } catch (error) {
    return serverError('portal.case', error);
  }
};

export const POST: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  const limited = await throttle(context.request, PORTAL_THROTTLES.reply, auth.scope.userId);
  if (limited) return limited;
  const body = ((await readJson(context.request)) ?? {}) as Record<string, unknown>;
  try {
    const result = await replyToPortalCase(
      connection.db,
      auth.scope,
      context.params.caseId ?? '',
      String(body.message ?? ''),
      new Date(),
    );
    if (result.ok) return ok(result.value, 201);
    // A case that is not theirs and a case that does not exist are the same
    // answer here as everywhere else in the portal.
    return result.reason === 'not_found'
      ? notFound('That request could not be found.')
      : invalid([{ field: result.field ?? 'message', message: result.reason }]);
  } catch (error) {
    return serverError('portal.reply', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
