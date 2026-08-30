/**
 * GET and PATCH /api/crm/opportunities/{id} on cms.murikah.com.
 *
 * The GET returns the opportunity with its product lines, the line
 * reconciliation and the stage history in one response, because the detail
 * page needs all three and three round trips would buy nothing.
 *
 * The PATCH edits commercial fields only. The stage and the status move
 * exclusively through the stage endpoint, so history cannot be skipped.
 */
import type { APIRoute } from 'astro';
import {
  requireOpportunitiesView,
  requireOpportunitiesEdit,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateOpportunityPatch } from '../../../../../lib/cms/admin/opportunityInput.ts';
import {
  getOpportunity,
  listProductLines,
  listStageHistory,
  reconcileLines,
  updateOpportunity,
} from '../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const opportunity = await getOpportunity(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
    );
    if (opportunity === null) return notFound('That opportunity could not be found.');
    const [products, history] = await Promise.all([
      listProductLines(connection.db, opportunity.opportunityId),
      listStageHistory(connection.db, opportunity.opportunityId),
    ]);
    return ok({
      opportunity,
      products,
      reconciliation: reconcileLines(opportunity.estimatedValue, products),
      history,
    });
  } catch (error) {
    return serverError('crm.opportunities.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireOpportunitiesEdit(context);
  if (!auth.ok) return auth.response;
  const parsed = validateOpportunityPatch(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updateOpportunity(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.opportunities.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
