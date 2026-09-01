/**
 * GET /api/orders/purchases/stock on cms.murikah.com.
 *
 * Where open sales demand and unposted purchase stock coincide by product
 * and entity. The wording travels with the rows and says what the rows are:
 * a correlation, in a schema that holds no link between a sales order and a
 * purchase order, and no claim that one is waiting for the other.
 */
import type { APIRoute } from 'astro';
import { requirePurchaseOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { stockConstraint } from '../../../../../lib/cms/repos/poPerformance.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requirePurchaseOrdersView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok(
      await stockConstraint(
        connection.db,
        auth.principal.user.userId,
        parseFilter(context.url.searchParams),
        toDbTimestamp(new Date()),
      ),
    );
  } catch (error) {
    return serverError('orders.purchases.stock', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
