/**
 * GET /api/crm/opportunities/summary?pipeline=... on cms.murikah.com.
 *
 * The aggregate foundation: count, value and weighted value by stage and by
 * currency, plus won, lost and the lost reasons, all computed in SQL under
 * the same scope predicate as the list. KES and USD are never added together
 * anywhere in the response.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { pipelineSummary } from '../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const pipelineId = context.url.searchParams.get('pipeline') ?? '';
  if (pipelineId === '') {
    return invalid([{ field: 'pipeline', message: 'Name the pipeline to summarise.' }]);
  }
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok(await pipelineSummary(connection.db, auth.principal.user.userId, pipelineId));
  } catch (error) {
    return serverError('crm.opportunities.summary', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
