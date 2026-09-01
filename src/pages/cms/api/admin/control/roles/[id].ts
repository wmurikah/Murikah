/**
 * GET /api/admin/control/roles/{id} on cms.murikah.com.
 *
 * Role Impact: what a role grants and who currently holds it, in one call.
 * Somebody about to add a permission to a role needs to see the people it
 * reaches before they add it, not afterwards, and nobody should have to
 * search user by user to find out.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { requireControlCentre } from '../../../../../../lib/cms/admin/guard.ts';
import { roleImpact } from '../../../../../../lib/cms/repos/controlCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireControlCentre(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const impact = await roleImpact(connection.db, context.params.id ?? '');
    return impact === null ? notFound('That role could not be found.') : ok({ role: impact });
  } catch (error) {
    return serverError('admin.control.roleImpact', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
