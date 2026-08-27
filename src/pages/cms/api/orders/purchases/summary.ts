/**
 * GET /api/orders/purchases/summary on cms.murikah.com.
 *
 * Coverage travels with the figures rather than behind them. In an early
 * implementation the stock timestamps are mostly absent, so a caller reading
 * this response sees how many orders carried each timestamp before it sees
 * any duration built on them.
 */
import type { APIRoute } from 'astro';
import { requirePurchaseOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { backlog, coverage, durations } from '../../../../../lib/cms/repos/poPerformance.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requirePurchaseOrdersView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const now = toDbTimestamp(new Date());
    const userId = auth.principal.user.userId;
    const [coverageRows, durationSet, backlogRows] = await Promise.all([
      coverage(connection.db, userId, filter, now),
      durations(connection.db, userId, filter, now),
      backlog(connection.db, userId, filter, now),
    ]);
    return ok({ filter, coverage: coverageRows, durations: durationSet, backlog: backlogRows });
  } catch (error) {
    return serverError('orders.purchases.summary', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
