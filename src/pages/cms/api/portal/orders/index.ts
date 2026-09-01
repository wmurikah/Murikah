/**
 * GET /api/portal/orders on cms.murikah.com.
 *
 * The caller's own orders, from the membership. There is no account
 * parameter that widens anything: `requirePortal` reads one, and uses it
 * only when the caller genuinely holds that membership.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { portalOrders } from '../../../../../lib/cms/repos/portalData.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  try {
    return ok({ orders: await portalOrders(connection.db, auth.scope) });
  } catch (error) {
    return serverError('portal.orders', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
