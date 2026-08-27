/**
 * GET /api/orders/sales/approvers on cms.murikah.com.
 *
 * One row per person per process per stage per affiliate, never a blended
 * average, with the minimum volume for a comparative rank stated in the
 * response rather than hidden in the code.
 */
import type { APIRoute } from 'astro';
import { requireSalesOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { approverPerformance } from '../../../../../lib/cms/repos/soPerformance.ts';
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
    return ok(
      await approverPerformance(
        connection.db,
        auth.principal.user.userId,
        filter,
        toDbTimestamp(new Date()),
      ),
    );
  } catch (error) {
    return serverError('orders.sales.approvers', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
