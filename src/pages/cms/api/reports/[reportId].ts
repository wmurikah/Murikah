/**
 * GET /api/reports/{reportId} on cms.murikah.com.
 *
 * Runs a report and returns its columns, rows, KPI definitions and notes.
 *
 * THE PERMISSION IS THE REPORT'S OWN. Each definition declares the code it
 * needs and this checks that one, so a caller who may read sales orders and
 * not cases gets the sales order reports and a 403 on the service ones,
 * rather than a menu that hides half of itself and an endpoint that would
 * have answered anyway.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { requireSignedIn } from '../../../../lib/cms/admin/guard.ts';
import { reportById } from '../../../../lib/cms/reports/catalogue.ts';
import { parseFilter } from '../../../../lib/cms/analytics/filters.ts';
import { toDbTimestamp } from '../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';
import { forbidden, notFound } from '../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const report = reportById(context.params.reportId ?? '');
  if (report === null) return notFound('That report does not exist.');
  if (!auth.principal.user.permissions.includes(report.permission)) {
    return forbidden(`This report needs ${report.permission}.`);
  }
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const now = toDbTimestamp(new Date());
    const filter = parseFilter(context.url.searchParams);
    const run = await report.run(
      connection.db,
      auth.principal.user.userId,
      filter,
      now,
      auth.principal.user.permissions,
    );
    return ok({
      report: {
        id: report.id,
        family: report.family,
        name: report.name,
        description: report.description,
        source: report.source,
        parameters: report.parameters,
        kpis: report.kpis,
      },
      filter,
      columns: run.columns,
      rows: run.rows,
      notes: run.notes,
      rowCount: run.rows.length,
    });
  } catch (error) {
    return serverError('reports.run', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
