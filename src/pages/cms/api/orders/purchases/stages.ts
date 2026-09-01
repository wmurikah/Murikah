/**
 * GET /api/orders/purchases/stages on cms.murikah.com.
 *
 * The stages that exist, in sequence, and each one's share of the approval
 * cycle. The share's method travels with the numbers, because a reader shown
 * a percentage assumes a mean unless told otherwise.
 */
import type { APIRoute } from 'astro';
import { requirePurchaseOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { bottleneck, stagePerformance } from '../../../../../lib/cms/repos/poPerformance.ts';
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
    const now = toDbTimestamp(new Date());
    const userId = auth.principal.user.userId;
    const [stages, shares] = await Promise.all([
      stagePerformance(connection.db, userId, filter, now),
      bottleneck(connection.db, userId, filter, now),
    ]);
    return ok({ filter, stages, bottleneck: shares });
  } catch (error) {
    return serverError('orders.purchases.stages', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
