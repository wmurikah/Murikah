/**
 * GET /api/service/analytics/time on cms.murikah.com.
 *
 * Where the elapsed time went, and how many cases could honestly be
 * decomposed. A case whose status history is incomplete is excluded and
 * counted, never estimated.
 */
import type { APIRoute } from 'astro';
import { requireCasesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { handoffs, waitingBreakdown } from '../../../../../lib/cms/repos/serviceAnalytics.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const [breakdown, chains] = await Promise.all([
      waitingBreakdown(connection.db, userId, filter),
      handoffs(connection.db, userId, filter),
    ]);
    return ok({ filter, breakdown, handoffs: chains });
  } catch (error) {
    return serverError('service.analytics.time', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
