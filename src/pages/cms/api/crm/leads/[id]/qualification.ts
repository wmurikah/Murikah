/**
 * POST /api/crm/leads/{id}/qualification on cms.murikah.com.
 *
 * Records a BANT assessment and sets the status to QUALIFIED.
 *
 * IT DOES NOT CONVERT. Nothing here writes an opportunity. A lead that looks
 * promising and a lead somebody has decided to pursue commercially are
 * different facts, and collapsing them would make every qualified lead a
 * pipeline entry without anybody choosing that.
 *
 * The four scores are checked from 0 to 5 here so a 6 comes back on the right
 * input, and again by the CHECK constraints on `lead_qualifications`, which are
 * the actual guarantee.
 */
import type { APIRoute } from 'astro';
import { requireLeadsManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateQualification } from '../../../../../../lib/cms/admin/leadInput.ts';
import { getQualification, qualifyLead } from '../../../../../../lib/cms/repos/leadAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireLeadsManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ qualification: await getQualification(connection.db, context.params.id ?? '') });
  } catch (error) {
    return serverError('crm.leads.qualification.get', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireLeadsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateQualification(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await qualifyLead(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.leads.qualify', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
