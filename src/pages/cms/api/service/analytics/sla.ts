/**
 * GET /api/service/analytics/sla on cms.murikah.com.
 *
 * External SLA is what the customer was promised; internal SLA is which
 * stage or team held responsibility. They are reported separately, and a
 * breach is attributed from the breach row and the assignment history rather
 * than to whoever happened to close the case.
 */
import type { APIRoute } from 'astro';
import { requireCasesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { breachAttribution, slaPicture } from '../../../../../lib/cms/repos/serviceAnalytics.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const now = toDbTimestamp(new Date());
    const [picture, attribution] = await Promise.all([
      slaPicture(connection.db, userId, filter, now),
      breachAttribution(connection.db, userId, filter),
    ]);
    return ok({ filter, sla: picture, attribution });
  } catch (error) {
    return serverError('service.analytics.sla', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
