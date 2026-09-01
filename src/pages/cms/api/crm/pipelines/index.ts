/**
 * GET and POST /api/crm/pipelines on cms.murikah.com.
 *
 * Reading the configuration needs only the opportunity view permission,
 * because the pipeline picker on the workspace is configuration read back.
 * Writing needs CRM.PIPELINES.MANAGE, which is administrative on purpose:
 * the stages define what every deal's history means.
 */
import type { APIRoute } from 'astro';
import {
  requireOpportunitiesView,
  requirePipelinesManage,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validatePipeline } from '../../../../../lib/cms/admin/opportunityInput.ts';
import { createPipeline, listPipelines } from '../../../../../lib/cms/repos/opportunityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ items: await listPipelines(connection.db) });
  } catch (error) {
    return serverError('crm.pipelines.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requirePipelinesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validatePipeline(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createPipeline(
      connection.db,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.pipelines.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
