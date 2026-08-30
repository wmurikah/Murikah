/**
 * GET and POST /api/crm/leads on cms.murikah.com.
 *
 * GET filters, searches and paginates in the database, with the scope predicate
 * from ../../../../lib/cms/repos/leadAdmin as the first clause. The total is
 * counted through the same predicate, and so are the workspace indicators, so a
 * card can never report a lead the caller cannot open.
 *
 * POST allocates the lead number server-side. No validator reads `leadNumber`
 * from the payload, so a caller cannot choose one.
 */
import type { APIRoute } from 'astro';
import {
  requireLeadsCreate,
  requireLeadsView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { readLeadQuery, validateLead } from '../../../../../lib/cms/admin/leadInput.ts';
import { createLead, leadIndicators, listLeads } from '../../../../../lib/cms/repos/leadAdmin.ts';
import { isoDay } from '../../../../../lib/cms/workflow/model.ts';
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
  const auth = requireLeadsView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const userId = auth.principal.user.userId;
    const [page, indicators] = await Promise.all([
      listLeads(connection.db, userId, readLeadQuery(context.url.searchParams)),
      leadIndicators(connection.db, userId),
    ]);
    return ok({ ...page, indicators });
  } catch (error) {
    return serverError('crm.leads.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireLeadsCreate(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateLead(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await createLead(connection.db, parsed.value, ctx);
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('crm.leads.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
