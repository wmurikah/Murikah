/**
 * GET /api/audit/events on cms.murikah.com.
 *
 * The audit list, server-paginated, inside the caller's own audit scope.
 *
 * THERE IS NO POST, PUT, PATCH OR DELETE ON THIS ROUTE OR ANY AUDIT ROUTE.
 * Not because they are unimplemented, but because an audit row is not
 * something the application may change: the database refuses an UPDATE and a
 * DELETE through the triggers in docs/cms/audit/08_audit_immutability.sql,
 * and a handler here would only produce a confusing error. A correction to
 * business data creates a new business change and a new audit event.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { requireAuditView } from '../../../../lib/cms/admin/guard.ts';
import {
  listAuditEvents,
  parseAuditFilter,
  auditFilterOptions,
} from '../../../../lib/cms/repos/auditTrail.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAuditView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const userId = auth.principal.user.userId;
  try {
    const filter = parseAuditFilter(context.url.searchParams, new Date());
    const [page, options] = await Promise.all([
      listAuditEvents(connection.db, userId, filter),
      auditFilterOptions(connection.db, userId),
    ]);
    return ok({ ...page, filter, options });
  } catch (error) {
    return serverError('audit.events', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
