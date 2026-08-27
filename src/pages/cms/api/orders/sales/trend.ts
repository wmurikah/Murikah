/**
 * GET /api/orders/sales/trend on cms.murikah.com.
 *
 * One bucket per period at the filter's grain, aggregated in SQL. The grain
 * defaults to the period's own length, because a year of daily points is
 * noise rather than a trend.
 */
import type { APIRoute } from 'astro';
import { requireSalesOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { trend } from '../../../../../lib/cms/repos/soPerformance.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSalesOrdersView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    return ok({
      filter,
      buckets: await trend(
        connection.db,
        auth.principal.user.userId,
        filter,
        toDbTimestamp(new Date()),
      ),
    });
  } catch (error) {
    return serverError('orders.sales.trend', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
