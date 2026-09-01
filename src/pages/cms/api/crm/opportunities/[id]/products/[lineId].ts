/**
 * DELETE /api/crm/opportunities/{id}/products/{lineId} on cms.murikah.com.
 *
 * Removes one product line. Lines are compositional detail of an open deal
 * rather than history in their own right, which is why this is the one
 * genuine DELETE in the CRM module; the removal itself is recorded in
 * `audit_events` as PRODUCT_REMOVED with the line's full before state.
 */
import type { APIRoute } from 'astro';
import {
  requireOpportunitiesEdit,
  writeContext,
} from '../../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../../lib/cms/admin/crudRoute.ts';
import { removeProductLine } from '../../../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  failure,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const DELETE: APIRoute = async (context) => {
  const auth = requireOpportunitiesEdit(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await removeProductLine(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      context.params.lineId ?? '',
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('crm.opportunities.products.remove', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('DELETE');
