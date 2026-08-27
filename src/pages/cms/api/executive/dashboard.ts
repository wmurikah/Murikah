/**
 * GET /api/executive/dashboard on cms.murikah.com.
 *
 * The whole composition in one response: the sections this caller's
 * permissions allow, the exceptions, the movements with their own desirable
 * directions, the connected insights and the freshness of each source. The
 * query count is returned so the cost of the page is a stated fact.
 *
 * NOTHING HERE IS CACHED. A cached figure served to the wrong scope is a
 * data breach rather than a performance bug, and a persistent cache would
 * need a Cloudflare binding, which is fenced.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../lib/cms/analytics/filters.ts';
import {
  attentionCustomers,
  connectedInsights,
  dashboard,
  entityComparison,
} from '../../../../lib/cms/repos/executive.ts';
import { toDbTimestamp } from '../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  // Signed in is the only requirement: what the page then contains is
  // decided by the caller's own permission codes, section by section.
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const now = toDbTimestamp(new Date());
    const userId = auth.principal.user.userId;
    const permissions = auth.principal.user.permissions;
    const board = await dashboard(connection.db, userId, permissions, filter, now);
    const [insights, attention, entities] = await Promise.all([
      connectedInsights(connection.db, userId, permissions, filter, now),
      attentionCustomers(connection.db, userId, filter, now),
      entityComparison(connection.db, userId, permissions, filter, now),
    ]);
    return ok({ filter, dashboard: board, insights, attentionCustomers: attention, entities });
  } catch (error) {
    return serverError('executive.dashboard', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
