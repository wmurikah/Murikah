/**
 * GET, POST and PATCH /api/admin/workflows/{id}/stages on cms.murikah.com.
 *
 * POST adds a stage. PATCH reorders every stage of the definition in one call,
 * which is deliberate: `UNIQUE(workflow_definition_id, sequence_no)` rejects a
 * stage-at-a-time reorder the moment two stages briefly share a position, and
 * swapping two adjacent stages does that on its very first statement. The
 * repository runs the reorder as an offset pass and then an assignment pass
 * inside one batch, so no intermediate state is ever visible or rejected.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowsManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateReorder, validateStage } from '../../../../../../lib/cms/admin/workflowInput.ts';
import {
  createStage,
  getDefinition,
  listStages,
  reorderStages,
} from '../../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

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
    return ok({ definition, items: await listStages(connection.db, id) });
  } catch (error) {
    return serverError('admin.workflows.stages', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateStage(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createStage(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.workflows.createStage', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateReorder(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await reorderStages(
      connection.db,
      context.params.id ?? '',
      parsed.value.order,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('admin.workflows.reorder', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET, POST or PATCH');
