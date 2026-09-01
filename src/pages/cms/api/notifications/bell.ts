/**
 * GET /api/notifications/bell on cms.murikah.com.
 *
 * The bell's numbers, off the page's critical path. Every CMS page used to
 * resolve the unread count — and, when it was non-zero, a five-row preview —
 * during layout render, so a person opening the Helpdesk paid notification
 * latency before a single byte of Helpdesk arrived. The shell now renders
 * immediately and the browser asks here shortly after first paint.
 *
 * TWO WEIGHTS, ONE ENDPOINT. The default answer is the count alone: one small
 * query, called once per page view. `?preview=1` adds the top unread rows and
 * is called only when somebody actually opens the menu — five records nobody
 * opened were fetched on every page for months, and almost nobody opens the
 * menu on most pages.
 *
 * Same security as the page had: the caller is the session's own user and
 * nothing else. `requireSignedIn` resolves the principal, the user id comes
 * from the session, and a userId in the query string is not read.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { unreadCount, listNotifications } from '../../../../lib/cms/notify/notifications.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const userId = auth.principal.user.userId;
    const count = await unreadCount(connection.db, userId);
    if (context.url.searchParams.get('preview') !== '1') return ok({ count });

    const items =
      count === 0
        ? []
        : (
            await listNotifications(connection.db, userId, {
              unreadOnly: true,
              type: null,
              page: 1,
            })
          ).items
            .slice(0, 5)
            .map((n) => ({ title: n.title, createdAt: n.createdAt }));
    return ok({ count, items });
  } catch (error) {
    return serverError('notifications.bell', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
