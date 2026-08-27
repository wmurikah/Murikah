/**
 * GET /api/audit/export on cms.murikah.com.
 *
 * Filtered audit evidence as CSV, under the caller's own scope, gated on
 * AUDIT.EVENTS.EXPORT, and auditing itself.
 *
 * SAME FILTERS, SAME SCOPE, SAME SECURITY GATE. The rows come from the same
 * clauses the screen uses, so a user cannot gain a single row by exporting
 * rather than reading, and a principal without SECURITY_VIEW exports no
 * security event.
 *
 * The `AUDIT_EXPORTED` row is written AFTER the file is generated and before
 * it is returned. Writing it first would record an export that then failed;
 * writing it after the response has gone would risk not writing it at all.
 * Generation is the point at which the evidence left the system.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { requireAuditView, writeContext } from '../../../../lib/cms/admin/guard.ts';
import {
  exportAuditCsv,
  auditExportStmt,
  parseAuditFilter,
} from '../../../../lib/cms/repos/auditTrail.ts';
import { canExportAudit, AUDIT_EXPORT } from '../../../../lib/cms/permissions.ts';
import { methodNotAllowed, serverError } from '../../../../lib/cms/admin/respond.ts';
import { forbidden } from '../../../../lib/cms/errors.ts';
import { toDbTimestamp } from '../../../../lib/cms/auth/session.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAuditView(context);
  if (!auth.ok) return auth.response;
  if (!canExportAudit(auth.principal.user.permissions)) {
    return forbidden(
      `Exporting audit evidence needs ${AUDIT_EXPORT}, which is not granted to you. If nobody holds it, the operator has not yet run docs/cms/audit/09_add_audit_permissions.sql.`,
    );
  }
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const ctx = writeContext(context.request, auth.principal);
  try {
    const filter = parseAuditFilter(context.url.searchParams, ctx.now);
    const generatedAt = toDbTimestamp(ctx.now);
    const result = await exportAuditCsv(
      connection.db,
      ctx.actorUserId,
      filter,
      generatedAt,
      auth.principal.user.displayName,
    );

    await connection.db.execute(
      auditExportStmt({
        actorUserId: ctx.actorUserId,
        filter,
        rowCount: result.rowCount,
        totalMatching: result.totalMatching,
        format: 'CSV',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
    );

    const filename = `audit-${filter.from}-to-${filter.to}.csv`;
    return new Response(result.csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return serverError('audit.export', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
