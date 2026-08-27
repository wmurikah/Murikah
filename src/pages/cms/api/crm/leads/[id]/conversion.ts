/**
 * POST /api/crm/leads/{id}/conversion on cms.murikah.com.
 *
 * One transactional operation that writes the opportunity, its first stage
 * history row and the lead's CONVERTED status together, or writes none of them.
 *
 * IT IS IDEMPOTENT, AND THE KEY IS `opportunities.lead_id`.
 * A repeated call returns the existing opportunity with `alreadyConverted:
 * true` and writes nothing. A genuine race is caught by the second guard: the
 * lead's status update is conditional on it not already being CONVERTED, so two
 * concurrent transactions serialise on the lead row and the loser writes
 * nothing. A double-clicked button produces one opportunity, not two.
 *
 * BOTH PERMISSIONS ARE REQUIRED. Conversion writes an opportunity as well as
 * closing the lead, so `CRM.LEADS.MANAGE` alone does not authorise it and
 * neither does `CRM.OPPORTUNITIES.EDIT`.
 */
import type { APIRoute } from 'astro';
import { requireLeadConvert, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateConvert } from '../../../../../../lib/cms/admin/leadInput.ts';
import { convertLead } from '../../../../../../lib/cms/repos/leadAdmin.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { conflict, notFound, validationFailed } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireLeadConvert(context);
  if (!auth.ok) return auth.response;

  const parsed = validateConvert(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await convertLead(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    if (result.ok) {
      // 200 rather than 201 on a repeat, because nothing was created.
      return ok(result.value, result.value.alreadyConverted ? 200 : 201);
    }
    switch (result.kind) {
      case 'not_found':
        return notFound('That lead could not be found.');
      case 'conflict':
        return conflict(result.fields);
      case 'invalid_reference':
        return validationFailed(result.fields);
    }
  } catch (error) {
    return serverError('crm.leads.convert', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
