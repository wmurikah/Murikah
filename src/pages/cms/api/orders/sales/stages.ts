/**
 * GET /api/orders/sales/stages on cms.murikah.com.
 *
 * Finance and credit turnaround, each as two labelled durations: elapsed,
 * which is what the customer waited, and accountable, which is the
 * pause-adjusted figure the SLA holds somebody to. The two are never
 * presented as one number.
 */
import type { APIRoute } from 'astro';
import { requireSalesOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { creditPicture, fulfilmentDurations } from '../../../../../lib/cms/repos/soPerformance.ts';
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
    const now = toDbTimestamp(new Date());
    const userId = auth.principal.user.userId;
    const [credit, fulfilment] = await Promise.all([
      creditPicture(connection.db, userId, filter, now),
      fulfilmentDurations(connection.db, userId, filter, now),
    ]);
    return ok({ filter, credit, fulfilment });
  } catch (error) {
    return serverError('orders.sales.stages', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
