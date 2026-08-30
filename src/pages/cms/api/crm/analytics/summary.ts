/**
 * GET /api/crm/analytics/summary on cms.murikah.com.
 *
 * The six signals and the funnel, each carrying the denominator it was taken
 * over. A rate without its denominator is not a number anybody can act on,
 * so the denominators travel in the response rather than living only in a
 * tooltip.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import {
  funnel,
  winRate,
  pipelineValue,
  firstContact,
} from '../../../../../lib/cms/repos/crmAnalytics.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const [funnelResult, win, pipeline, contact] = await Promise.all([
      funnel(connection.db, userId, filter),
      winRate(connection.db, userId, filter),
      pipelineValue(connection.db, userId, filter),
      firstContact(connection.db, userId, filter),
    ]);
    return ok({ filter, funnel: funnelResult, winRate: win, pipeline, firstContact: contact });
  } catch (error) {
    return serverError('crm.analytics.summary', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
