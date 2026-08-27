/**
 * GET and PATCH /api/crm/leads/{id} on cms.murikah.com.
 *
 * Out of scope and non-existent both answer 404, deliberately, so a probe
 * cannot use the difference to learn that a lead exists in a business unit the
 * caller cannot see.
 *
 * PATCH edits the lead. It cannot move the status: `lead_number`, `status` and
 * `created_by_user_id` are absent from the repository's SET list, so the
 * transitions happen only through the named actions that record why.
 */
import type { APIRoute } from 'astro';
import {
  requireLeadsManage,
  requireLeadsView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateLead } from '../../../../../lib/cms/admin/leadInput.ts';
import { getLead, getQualification, updateLead } from '../../../../../lib/cms/repos/leadAdmin.ts';
import { isoDay } from '../../../../../lib/cms/workflow/model.ts';
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
  const auth = requireLeadsView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const id = context.params.id ?? '';
    const lead = await getLead(connection.db, auth.principal.user.userId, id);
    if (lead === null) return notFound('That lead could not be found.');
    return ok({ lead, qualification: await getQualification(connection.db, id) });
  } catch (error) {
    return serverError('crm.leads.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireLeadsManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateLead(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updateLead(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      ctx,
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.leads.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
