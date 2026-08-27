/**
 * GET /api/crm/analytics/sources on cms.murikah.com.
 *
 * Lead sources and BANT. Customer-service-originated leads are flagged so
 * that team's commercial contribution is visible, which is a stated business
 * requirement and the thing they would otherwise get no credit for.
 */
import type { APIRoute } from 'astro';
import { requireLeadsView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { bant, leadSourcePerformance } from '../../../../../lib/cms/repos/crmAnalytics.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireLeadsView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const [sources, bantRows] = await Promise.all([
      leadSourcePerformance(connection.db, userId, filter),
      bant(connection.db, userId, filter),
    ]);
    return ok({ filter, sources, bant: bantRows });
  } catch (error) {
    return serverError('crm.analytics.sources', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
