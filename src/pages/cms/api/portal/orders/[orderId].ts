/**
 * GET /api/portal/orders/{orderId} on cms.murikah.com.
 *
 * ONE REFUSAL FOR THREE CASES. An order that belongs to another customer,
 * an order that does not exist and an identifier that is nonsense all
 * produce the same not-found. A different status or message for any of them
 * would confirm the first one exists, which is the leak this endpoint is
 * written to prevent.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { portalOrder } from '../../../../../lib/cms/repos/portalData.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  try {
    const order = await portalOrder(connection.db, auth.scope, context.params.orderId ?? '');
    return order === null ? notFound('That order could not be found.') : ok({ order });
  } catch (error) {
    return serverError('portal.order', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
