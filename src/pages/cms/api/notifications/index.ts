/**
 * GET /api/notifications on cms.murikah.com. POST marks all read.
 *
 * Reading your notifications is also an entry into the engine: the SLA
 * sweep and the notification sweep run first, so the list is current the
 * moment it is read rather than waiting for some other trigger.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import {
  listNotifications,
  markAllRead,
  sweepNotifications,
} from '../../../../lib/cms/notify/notifications.ts';
import { sweepDueSlas } from '../../../../lib/cms/sla/engine.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const now = new Date();
    await sweepDueSlas(connection.db, now);
    await sweepNotifications(connection.db, now);
    const params = context.url.searchParams;
    const page = Number(params.get('page') ?? '1');
    return ok(
      await listNotifications(connection.db, auth.principal.user.userId, {
        unreadOnly: params.get('unread') === '1',
        type: params.get('type') || null,
        page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
      }),
    );
  } catch (error) {
    return serverError('notifications.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    await markAllRead(connection.db, auth.principal.user.userId, new Date());
    return ok({ done: true });
  } catch (error) {
    return serverError('notifications.markAllRead', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
