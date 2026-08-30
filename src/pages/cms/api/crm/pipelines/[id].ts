/**
 * GET and PATCH /api/crm/pipelines/{id} on cms.murikah.com.
 */
import type { APIRoute } from 'astro';
import {
  requireOpportunitiesView,
  requirePipelinesManage,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validatePipeline } from '../../../../../lib/cms/admin/opportunityInput.ts';
import { getPipeline, updatePipeline } from '../../../../../lib/cms/repos/opportunityAdmin.ts';
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
  const auth = requireOpportunitiesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const pipeline = await getPipeline(connection.db, context.params.id ?? '');
    return pipeline === null ? notFound('That pipeline could not be found.') : ok(pipeline);
  } catch (error) {
    return serverError('crm.pipelines.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requirePipelinesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validatePipeline(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updatePipeline(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.pipelines.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
