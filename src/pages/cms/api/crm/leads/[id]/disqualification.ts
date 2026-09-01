/**
 * POST /api/crm/leads/{id}/disqualification on cms.murikah.com.
 *
 * Requires a reason and preserves everything: the lead, its qualification and
 * its history all stay, and the status is reversible by a later edit if the
 * customer comes back.
 *
 * The reason is free text. No configurable reason table exists for leads,
 * unlike `lost_reasons` for opportunities, and hard-coding a list here would
 * invent a taxonomy the business has not agreed. Suggestions belong in the
 * interface.
 */
import type { APIRoute } from 'astro';
import { requireLeadsManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateDisqualify } from '../../../../../../lib/cms/admin/leadInput.ts';
import { disqualifyLead } from '../../../../../../lib/cms/repos/leadAdmin.ts';
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
  const auth = requireLeadsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateDisqualify(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await disqualifyLead(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value.reason,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.leads.disqualify', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
