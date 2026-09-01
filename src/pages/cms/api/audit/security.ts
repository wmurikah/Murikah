/**
 * GET /api/audit/security on cms.murikah.com.
 *
 * The authentication and access view, gated on AUDIT.EVENTS.SECURITY_VIEW.
 *
 * That code does not exist until the operator runs
 * docs/cms/audit/09_add_audit_permissions.sql, so this endpoint correctly
 * refuses everybody, the system administrator included, until then. It says
 * which code is missing rather than answering an empty list, because an empty
 * security view and an unconfigured one are different facts and a reader
 * investigating an incident must not be shown the first for the second.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { requireAuditView } from '../../../../lib/cms/admin/guard.ts';
import {
  securityEvents,
  parseAuditFilter,
  maySeeSecurityEvents,
} from '../../../../lib/cms/repos/auditTrail.ts';
import { AUDIT_SECURITY_VIEW } from '../../../../lib/cms/permissions.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';
import { forbidden } from '../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAuditView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const userId = auth.principal.user.userId;
  try {
    if (!(await maySeeSecurityEvents(connection.db, userId))) {
      return forbidden(
        `Security events need ${AUDIT_SECURITY_VIEW}, which is not granted to you. If nobody holds it, the operator has not yet run docs/cms/audit/09_add_audit_permissions.sql.`,
      );
    }
    const filter = parseAuditFilter(context.url.searchParams, new Date());
    return ok({ ...(await securityEvents(connection.db, userId, filter)), filter });
  } catch (error) {
    return serverError('audit.security', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
