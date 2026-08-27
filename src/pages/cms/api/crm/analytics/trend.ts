/**
 * GET /api/crm/analytics/trend on cms.murikah.com.
 *
 * Lead and opportunity movement per period, at the filter's own grain.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { trend } from '../../../../../lib/cms/repos/crmAnalytics.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    return ok({
      filter,
      buckets: await trend(connection.db, auth.principal.user.userId, filter),
    });
  } catch (error) {
    return serverError('crm.analytics.trend', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
