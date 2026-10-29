/**
 * GET /api/orders/purchases/trend on cms.murikah.com.
 *
 * Volume, approval cycle, receipt to posting, SLA compliance and pending
 * backlog per period. A period with no measurable posting reports null
 * rather than a zero that would claim the stock posted instantly.
 */
import type { APIRoute } from 'astro';
import { requirePurchaseOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { trend } from '../../../../../lib/cms/repos/poPerformance.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requirePurchaseOrdersView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
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
    return serverError('orders.purchases.trend', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
