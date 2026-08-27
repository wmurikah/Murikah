/**
 * GET /api/orders/sales/export on cms.murikah.com.
 *
 * The filtered detail as CSV, for a caller who may read sales orders. The
 * rows come from the same population as the list, so nothing outside the
 * caller's scope can leave through here, and every value that could be read
 * as a formula is defused before it is written.
 */
import type { APIRoute } from 'astro';
import { requireSalesOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { filterToQuery, parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { exportCsv } from '../../../../../lib/cms/repos/soPerformance.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSalesOrdersView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const now = toDbTimestamp(new Date());
    const described = filterToQuery(filter) === '' ? 'none' : filterToQuery(filter).slice(1);
    const csv = await exportCsv(connection.db, auth.principal.user.userId, filter, now, described);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="sales-orders-${now.slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return serverError('orders.sales.export', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
