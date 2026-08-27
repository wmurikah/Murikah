/**
 * POST /api/notifications/{id}/read on cms.murikah.com.
 *
 * Stamps read_at, once, for the caller's own row only. Unread is
 * read_at IS NULL; there is no boolean to keep in step.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { markRead } from '../../../../../lib/cms/notify/notifications.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    await markRead(connection.db, auth.principal.user.userId, context.params.id ?? '', new Date());
    return ok({ done: true });
  } catch (error) {
    return serverError('notifications.markRead', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
