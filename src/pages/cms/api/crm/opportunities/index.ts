/**
 * GET and POST /api/crm/opportunities on cms.murikah.com.
 *
 * The list is scope-filtered, searched, filtered and paginated in SQL. The
 * create validates the account through the caller's own customer scope, so an
 * out-of-scope account and a non-existent one are indistinguishable.
 */
import type { APIRoute } from 'astro';
import {
  requireOpportunitiesView,
  requireOpportunitiesEdit,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  readOpportunityQuery,
  validateOpportunity,
} from '../../../../../lib/cms/admin/opportunityInput.ts';
import {
  createOpportunity,
  listOpportunities,
} from '../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok(
      await listOpportunities(
        connection.db,
        auth.principal.user.userId,
        readOpportunityQuery(context.url.searchParams),
      ),
    );
  } catch (error) {
    return serverError('crm.opportunities.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireOpportunitiesEdit(context);
  if (!auth.ok) return auth.response;
  const parsed = validateOpportunity(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createOpportunity(
      connection.db,
      auth.principal.user.userId,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.opportunities.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
