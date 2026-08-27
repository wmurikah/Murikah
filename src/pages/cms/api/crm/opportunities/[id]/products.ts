/**
 * POST /api/crm/opportunities/{id}/products on cms.murikah.com.
 *
 * Adds a product line. The product must exist in the shared catalogue: there
 * is no free-text product on an opportunity, which is the deliberate
 * difference from a lead's free-text product interest.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesEdit, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateProductLine } from '../../../../../../lib/cms/admin/opportunityInput.ts';
import { addProductLine } from '../../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireOpportunitiesEdit(context);
  if (!auth.ok) return auth.response;
  const parsed = validateProductLine(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await addProductLine(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('crm.opportunities.products.add', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
