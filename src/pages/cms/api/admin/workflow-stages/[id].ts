/**
 * GET and PATCH /api/admin/workflow-stages/{id} on cms.murikah.com.
 *
 * `sequence_no` is not in the update. Position is changed through
 * PATCH /api/admin/workflows/{id}/stages, which reorders the whole set at once
 * for the reason stated there. Allowing a single stage to take a new position
 * here would be the naive path the UNIQUE constraint rejects.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowsManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateStage } from '../../../../../lib/cms/admin/workflowInput.ts';
import { getStage, updateStage } from '../../../../../lib/cms/repos/workflowAdmin.ts';
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
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const stage = await getStage(connection.db, context.params.id ?? '');
    return stage === null ? notFound('That stage could not be found.') : ok(stage);
  } catch (error) {
    return serverError('admin.workflowStages.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const parsed = validateStage(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const existing = await getStage(connection.db, id);
    if (existing === null) return notFound('That stage could not be found.');
    const result = await updateStage(
      connection.db,
      id,
      { ...parsed.value, sequenceNo: existing.sequenceNo },
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.workflowStages.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
