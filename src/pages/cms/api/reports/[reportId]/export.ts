/**
 * GET /api/reports/{reportId}/export on cms.murikah.com.
 *
 * CSV or XLSX, generated on the server, streamed as an attachment, and
 * audited as `REPORT_EXPORTED` with the filters and the row count and NOT the
 * content.
 *
 * THE FILE IS BUILT BEFORE THE RESPONSE EXISTS, so this endpoint cannot
 * report a file as ready before it is: there is no queue, no job identifier
 * and no polling URL to return early with. If a report ever grows beyond what
 * one request can build, that is a decision to escalate rather than a
 * background job to invent, and the ceiling below makes the limit visible
 * instead of leaving it to a timeout.
 *
 * AUTHENTICATED DOWNLOAD, NO PERMANENT URL, NO STORAGE KEY. The bytes are the
 * response body. Nothing is written to storage, so there is no object to
 * leave behind, no key to leak and no link that outlives the session.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireSignedIn, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { reportById } from '../../../../../lib/cms/reports/catalogue.ts';
import {
  toCsv,
  toXlsx,
  describeFilter,
  exportFilename,
  MAX_EXPORT_ROWS,
  reportExportStmt,
} from '../../../../../lib/cms/reports/export.ts';
import { parseFilter } from '../../../../../lib/cms/analytics/filters.ts';
import { freshness } from '../../../../../lib/cms/repos/executive.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';
import { methodNotAllowed, serverError, invalid } from '../../../../../lib/cms/admin/respond.ts';
import { forbidden, notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const report = reportById(context.params.reportId ?? '');
  if (report === null) return notFound('That report does not exist.');
  if (!auth.principal.user.permissions.includes(report.permission)) {
    // The same code the screen needs. A user must never gain data by
    // exporting it, and that starts with not being able to export a report
    // they could not open.
    return forbidden(`This report needs ${report.permission}.`);
  }

  const format = (context.url.searchParams.get('format') ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'xlsx') {
    return invalid([{ field: 'format', message: 'Choose csv or xlsx.' }]);
  }

  const connection = await connect();
  if ('response' in connection) return connection.response;
  const ctx = writeContext(context.request, auth.principal);

  try {
    const now = toDbTimestamp(ctx.now);
    const filter = parseFilter(context.url.searchParams);
    const run = await report.run(
      connection.db,
      ctx.actorUserId,
      filter,
      now,
      auth.principal.user.permissions,
    );

    if (run.rows.length > MAX_EXPORT_ROWS) {
      // Refused rather than truncated. A truncated export is the dangerous
      // outcome: it looks complete, somebody sums it, and the total is wrong
      // with nothing on the page to say so.
      return invalid([
        {
          field: 'filter',
          message: `That selection produces ${run.rows.length} rows, above the ${MAX_EXPORT_ROWS} an export builds in one request. Narrow the date range or the scope. Nothing was truncated.`,
        },
      ]);
    }

    // The freshness figures the executive dashboard shows, so the file states
    // how old its extract data is rather than implying it is live.
    const fresh = await freshness(connection.db).catch(() => null);
    const meta = {
      reportName: report.name,
      generatedAt: now,
      generatedBy: auth.principal.user.displayName,
      filters: describeFilter(filter),
      dateBasis: report.kpis[0]?.dateBasis ?? 'Not applicable',
      dataFreshness:
        fresh === null
          ? 'Not available'
          : fresh
              .map((row) =>
                row.live
                  ? `${row.source}: live`
                  : // Never "as at now" for extract data: the file is as old
                    // as the upload behind it and the export says so.
                    `${row.source}: last imported ${row.lastImportedAt ?? 'never'}`,
              )
              .join('; '),
      rowCount: run.rows.length,
    };

    const body =
      format === 'csv'
        ? new TextEncoder().encode(toCsv(report, run, meta))
        : toXlsx(report, run, meta);

    await connection.db.execute(
      reportExportStmt({
        actorUserId: ctx.actorUserId,
        report,
        filter,
        rowCount: run.rows.length,
        format: format.toUpperCase(),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
    );

    return new Response(body as BodyInit, {
      status: 200,
      headers: {
        'content-type':
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${exportFilename(report, filter, format)}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return serverError('reports.export', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
