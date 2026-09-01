/**
 * GET /api/notifications/{id}/target on cms.murikah.com.
 *
 * Where the notification leads, decided by re-running access control NOW. A
 * notification is not an access grant: rights revoked since it was created
 * produce a null destination and the interface shows a safe message rather
 * than the record.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  listNotifications,
  resolveNotificationTarget,
} from '../../../../../lib/cms/notify/notifications.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const userId = auth.principal.user.userId;
    const mine = await listNotifications(connection.db, userId, {
      unreadOnly: false,
      type: null,
      page: 1,
    });
    const notification = mine.items.find((n) => n.notificationId === (context.params.id ?? ''));
    if (notification === undefined) {
      const deeper = await connection.db.execute({
        sql: `SELECT notification_id, notification_type, title, message, entity_type, entity_id,
                     created_at, read_at
              FROM notifications WHERE notification_id = ? AND user_id = ? LIMIT 1`,
        args: [context.params.id ?? '', userId],
      });
      const row = deeper.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return notFound('That notification could not be found.');
      const target = await resolveNotificationTarget(connection.db, userId, {
        notificationId: String(row.notification_id),
        notificationType: String(row.notification_type) as never,
        title: String(row.title),
        message: String(row.message),
        entityType: row.entity_type === null ? null : String(row.entity_type),
        entityId: row.entity_id === null ? null : String(row.entity_id),
        createdAt: String(row.created_at),
        readAt: row.read_at === null ? null : String(row.read_at),
      });
      return ok({ target });
    }
    const target = await resolveNotificationTarget(connection.db, userId, notification);
    return ok({ target });
  } catch (error) {
    return serverError('notifications.target', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
