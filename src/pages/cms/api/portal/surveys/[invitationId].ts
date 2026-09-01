/**
 * POST /api/portal/surveys/{invitationId} on cms.murikah.com.
 *
 * One invitation admits one response, and the database is what enforces it:
 * `survey_invitations.survey_response_id` is UNIQUE. A second submission
 * fails on the constraint and is reported as already answered rather than
 * crashing, and no duplicate prevention is improvised in the interface.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { answerPortalSurvey } from '../../../../../lib/cms/repos/portalWrites.ts';
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

export const POST: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  const limited = await throttle(context.request, PORTAL_THROTTLES.survey, auth.scope.userId);
  if (limited) return limited;
  const body = ((await readJson(context.request)) ?? {}) as Record<string, unknown>;
  try {
    const result = await answerPortalSurvey(
      connection.db,
      auth.scope,
      context.params.invitationId ?? '',
      Number(body.score),
      body.comments === undefined || body.comments === null ? null : String(body.comments),
      new Date(),
    );
    if (result.ok) return ok(result.value, 201);
    return result.reason === 'not_found'
      ? notFound('That survey could not be found.')
      : invalid([{ field: result.field ?? 'score', message: result.reason }]);
  } catch (error) {
    return serverError('portal.survey', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
