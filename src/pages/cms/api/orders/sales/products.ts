/**
 * GET /api/orders/sales/products on cms.murikah.com.
 *
 * The product hierarchy: group, category, product. Quantities stay NULL
 * where the source carries none, and units are never added across
 * incompatible measures.
 */
import type { APIRoute } from 'astro';
import { requireSalesOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { productPerformance } from '../../../../../lib/cms/repos/soPerformance.ts';
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
      products: await productPerformance(
        connection.db,
        auth.principal.user.userId,
        filter,
        toDbTimestamp(new Date()),
      ),
    });
  } catch (error) {
    return serverError('orders.sales.products', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
