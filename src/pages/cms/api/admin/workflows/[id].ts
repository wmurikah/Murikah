/**
 * GET and PATCH /api/admin/workflows/{id} on cms.murikah.com.
 *
 * GET returns the definition and its stages in sequence.
 *
 * PATCH edits the definition in place, and the repository refuses a substantive
 * edit once a workflow instance exists under it. That is section 12: version 1
 * describes what every record created under it went through, and rewriting it
 * rewrites their history. The way forward is
 * POST /api/admin/workflows/{id}/versions.
 *
 * Retiring a version, by clearing `active` or setting `effective_to`, stays
 * allowed even with instances, because it does not change what the version
 * meant. It says the version no longer applies to new transactions, which is
 * exactly how a version is superseded.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowsManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateDefinition } from '../../../../../lib/cms/admin/workflowInput.ts';
import {
  getDefinition,
  listStages,
  updateDefinition,
} from '../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const definition = await getDefinition(connection.db, id);
    if (definition === null) return notFound('That workflow could not be found.');
    return ok({ definition, stages: await listStages(connection.db, id) });
  } catch (error) {
    return serverError('admin.workflows.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateDefinition(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateDefinition(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      ctx,
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.workflows.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
