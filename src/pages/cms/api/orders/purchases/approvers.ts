/**
 * GET /api/orders/purchases/approvers on cms.murikah.com.
 *
 * One row per person per stage. The authority context is derived from the
 * affiliates the person's transactions actually span, so a Group approver's
 * turnaround is never reported as a single country's performance.
 */
import type { APIRoute } from 'astro';
import { requirePurchaseOrdersView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { approverPerformance } from '../../../../../lib/cms/repos/poPerformance.ts';
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
      await approverPerformance(
        connection.db,
        auth.principal.user.userId,
        parseFilter(context.url.searchParams),
        toDbTimestamp(new Date()),
      ),
    );
  } catch (error) {
    return serverError('orders.purchases.approvers', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
