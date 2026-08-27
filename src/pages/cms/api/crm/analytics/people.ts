/**
 * GET /api/crm/analytics/people on cms.murikah.com.
 *
 * Owners and teams. Team attribution uses effective-dated membership, so a
 * lead captured in March belongs to the team its owner was in during March
 * rather than to the team they joined in July.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { ownerPerformance, teamPerformance } from '../../../../../lib/cms/repos/crmAnalytics.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const [owners, teams] = await Promise.all([
      ownerPerformance(connection.db, userId, filter, toDbTimestamp(new Date())),
      teamPerformance(connection.db, userId, filter),
    ]);
    return ok({ filter, owners, teams });
  } catch (error) {
    return serverError('crm.analytics.people', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
