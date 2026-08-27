/**
 * GET /api/crm/analytics/pipeline on cms.murikah.com.
 *
 * Stage occupancy and stage velocity, which answer different questions.
 * Occupancy is where opportunities are sitting now; velocity is how long
 * they historically took to leave, from the stage history, so the deals that
 * have already moved on are counted rather than ignored.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { stageOccupancy, stageVelocity } from '../../../../../lib/cms/repos/crmAnalytics.ts';
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
    const [occupancy, velocity] = await Promise.all([
      stageOccupancy(connection.db, userId, filter, toDbTimestamp(new Date())),
      stageVelocity(connection.db, userId, filter),
    ]);
    return ok({ filter, occupancy, velocity });
  } catch (error) {
    return serverError('crm.analytics.pipeline', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
