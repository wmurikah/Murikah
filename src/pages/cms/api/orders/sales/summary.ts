/**
 * GET /api/orders/sales/summary on cms.murikah.com.
 *
 * The signals, the credit picture, the fulfilment durations and the backlog,
 * all under one filter and one scope. Everything is aggregated in SQL: this
 * endpoint never returns orders for a browser to reduce.
 */
import type { APIRoute } from 'astro';
import { requireSalesOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { soSummary } from '../../../../../lib/cms/repos/soPerformance.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSalesOrdersView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const now = toDbTimestamp(new Date());
    return ok({
      filter,
      summary: await soSummary(connection.db, auth.principal.user.userId, filter, now),
    });
  } catch (error) {
    return serverError('orders.sales.summary', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
