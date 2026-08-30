/**
 * PATCH /api/crm/pipeline-stages/{id} on cms.murikah.com.
 *
 * Edits one stage: name, default probability, target days, flags, active.
 * The one rule the database does not hold is held here: a stage is never
 * both won and lost. There is no DELETE; a used stage deactivates.
 */
import type { APIRoute } from 'astro';
import { requirePipelinesManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateStage } from '../../../../../lib/cms/admin/opportunityInput.ts';
import { updateStage } from '../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  const auth = requirePipelinesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateStage(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updateStage(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.pipelineStages.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
