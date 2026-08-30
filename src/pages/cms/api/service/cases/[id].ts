/**
 * GET /api/service/cases/{id} on cms.murikah.com.
 *
 * The case with its histories, communications and survey responses in one
 * response. The scope predicate decides whether the case exists for this
 * caller; assignment alone never does.
 */
import type { APIRoute } from 'astro';
import { requireCasesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  getCase,
  listAssignmentHistory,
  listCommunications,
  listStatusHistory,
  listCaseSurveyResponses,
} from '../../../../../lib/cms/repos/serviceAdmin.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const userId = auth.principal.user.userId;
    const caseId = context.params.id ?? '';
    const found = await getCase(connection.db, userId, caseId);
    if (found === null) return notFound('That case could not be found.');
    const [assignments, statuses, communications, surveys] = await Promise.all([
      listAssignmentHistory(connection.db, caseId),
      listStatusHistory(connection.db, caseId),
      listCommunications(connection.db, userId, caseId),
      listCaseSurveyResponses(connection.db, userId, caseId),
    ]);
    return ok({
      case: found,
      assignments,
      statuses,
      communications: communications ?? [],
      surveyResponses: surveys ?? [],
    });
  } catch (error) {
    return serverError('service.cases.get', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
