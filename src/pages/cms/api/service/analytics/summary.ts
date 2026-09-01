/**
 * GET /api/service/analytics/summary on cms.murikah.com.
 *
 * The six signals, with resolution reported twice and labelled: elapsed,
 * which is what the customer experienced, and accountable, which is the
 * pause-adjusted figure. CSAT travels with its sample count, because one
 * response is not a headline.
 */
import type { APIRoute } from 'astro';
import { requireCasesView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import {
  summary,
  categoryMix,
  feedbackCoverage,
  surveyScores,
} from '../../../../../lib/cms/repos/serviceAnalytics.ts';
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
    const [signals, categories, coverage, scores] = await Promise.all([
      summary(connection.db, userId, filter),
      categoryMix(connection.db, userId, filter),
      feedbackCoverage(connection.db, userId, filter),
      surveyScores(connection.db, userId, filter),
    ]);
    return ok({
      filter,
      summary: signals,
      categories,
      feedbackCoverage: coverage,
      surveys: scores,
    });
  } catch (error) {
    return serverError('service.analytics.summary', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
