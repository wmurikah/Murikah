/**
 * GET /api/admin/control/authority on cms.murikah.com.
 *
 * Workflow Authority Review. It answers "who can approve Kenya sales order
 * finance today" in one query: the process, the geography and the date are
 * clauses in the SQL rather than a filter applied afterwards in TypeScript,
 * so the answer does not depend on how many rows the first query returned.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireControlCentre } from '../../../../../lib/cms/admin/guard.ts';
import { authorityReview } from '../../../../../lib/cms/repos/controlCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireControlCentre(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const params = context.url.searchParams;
  try {
    // An explicit `effectiveOn=all` asks for the history. Anything else, the
    // default included, asks about a date, because "who can approve" without
    // a date is a question with no useful answer.
    const asAt = params.get('effectiveOn');
    const effectiveOn =
      asAt === 'all'
        ? null
        : asAt !== null && asAt !== ''
          ? asAt
          : toDbTimestamp(new Date()).slice(0, 10);
    const rows = await authorityReview(connection.db, {
      processType: params.get('processType'),
      countryId: params.get('countryId'),
      affiliateId: params.get('affiliateId'),
      businessUnitId: params.get('businessUnitId'),
      userId: params.get('userId'),
      effectiveOn,
    });
    return ok({ rows, effectiveOn });
  } catch (error) {
    return serverError('admin.control.authority', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
