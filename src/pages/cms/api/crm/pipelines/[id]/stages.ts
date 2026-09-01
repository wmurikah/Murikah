/**
 * POST /api/crm/pipelines/{id}/stages on cms.murikah.com.
 *
 * Adds a stage at the end of the pipeline. Position is changed only through
 * the stage-order endpoint, which carries the history warning; adding never
 * reshuffles what is already there.
 */
import type { APIRoute } from 'astro';
import { requirePipelinesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateStage } from '../../../../../../lib/cms/admin/opportunityInput.ts';
import { addStage } from '../../../../../../lib/cms/repos/opportunityAdmin.ts';
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
  const auth = requirePipelinesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateStage(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await addStage(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.pipelines.stages.add', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
