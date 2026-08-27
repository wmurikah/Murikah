/**
 * GET /api/service/analytics/customers on cms.murikah.com.
 *
 * By customer, by affiliate and by team. A complaint rate appears only where
 * a defensible denominator exists; where it does not, the count is reported
 * and no rate is offered.
 */
import type { APIRoute } from 'astro';
import { requireCasesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import {
  customerView,
  entityView,
  repeatIssues,
  teamView,
} from '../../../../../lib/cms/repos/serviceAnalytics.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const filter = parseFilter(context.url.searchParams);
    const userId = auth.principal.user.userId;
    const [customers, entities, teams, repeats] = await Promise.all([
      customerView(connection.db, userId, filter),
      entityView(connection.db, userId, filter),
      teamView(connection.db, userId, filter),
      repeatIssues(connection.db, userId, filter),
    ]);
    return ok({ filter, customers, entities, teams, repeats });
  } catch (error) {
    return serverError('service.analytics.customers', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
