/**
 * POST /api/crm/pipelines/{id}/stage-order on cms.murikah.com.
 *
 * Rewrites the sequence of every stage in one transaction, in two passes so
 * UNIQUE(pipeline_id, sequence_no) is never violated mid-flight. The admin
 * screen carries the warning this endpoint enforces nothing about: reordering
 * a used pipeline rewrites what its history means, and the safer act is a new
 * pipeline.
 */
import type { APIRoute } from 'astro';
import { requirePipelinesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateStageOrder } from '../../../../../../lib/cms/admin/opportunityInput.ts';
import { reorderStages } from '../../../../../../lib/cms/repos/opportunityAdmin.ts';
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
  const parsed = validateStageOrder(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await reorderStages(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.pipelines.stageOrder', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
