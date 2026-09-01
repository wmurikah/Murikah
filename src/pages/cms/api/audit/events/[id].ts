/**
 * GET /api/audit/events/{id} on cms.murikah.com.
 *
 * One event with its field-level diff. The audit scope is applied here and
 * not merely in the list: an identifier lifted from somebody else's screen is
 * not authorisation, and a detail endpoint that trusted the list to have
 * filtered would be the hole.
 *
 * Not yours and does not exist give the same 404, for the same reason they do
 * in the portal: a different answer for the two confirms the first exists.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireAuditView } from '../../../../../lib/cms/admin/guard.ts';
import { auditEvent } from '../../../../../lib/cms/repos/auditTrail.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAuditView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const record = await auditEvent(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
    );
    return record === null
      ? notFound('That audit event could not be found.')
      : ok({ event: record });
  } catch (error) {
    return serverError('audit.event', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
