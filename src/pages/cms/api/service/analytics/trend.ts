/**
 * GET /api/service/analytics/trend on cms.murikah.com.
 *
 * Volume, first response, resolution, SLA and satisfaction per period, plus
 * the insight cards, each of which carries its arithmetic and its sample.
 */
import type { APIRoute } from 'astro';
import { requireCasesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { insights, trend } from '../../../../../lib/cms/repos/serviceAnalytics.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const [buckets, cards] = await Promise.all([
      trend(connection.db, userId, filter),
      insights(connection.db, userId, filter),
    ]);
    return ok({ filter, buckets, insights: cards });
  } catch (error) {
    return serverError('service.analytics.trend', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
