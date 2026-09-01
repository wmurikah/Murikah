/**
 * PATCH and DELETE /api/admin/job-title-mappings/{id} on cms.murikah.com.
 *
 * PATCH turns a default on or off; DELETE removes it. Neither changes any
 * user's access: a mapping is a suggestion the user administration screen
 * offers, and nobody's roles were ever derived from it. `?kind=WORKFLOW`
 * selects the workflow role table; ACCESS is the default.
 */
import type { APIRoute } from 'astro';
import { requireRolesManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateMappingUpdate } from '../../../../../lib/cms/admin/jobTitleMappingInput.ts';
import {
  deleteMapping,
  updateMapping,
  type MappingKind,
} from '../../../../../lib/cms/repos/jobTitleMappings.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

function kindOf(value: string | null): MappingKind {
  return String(value ?? '').toUpperCase() === 'WORKFLOW' ? 'WORKFLOW' : 'ACCESS';
}

export const PATCH: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateMappingUpdate(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateMapping(
      connection.db,
      kindOf(context.url.searchParams.get('kind')),
      context.params.id ?? '',
      parsed.value.active,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.jobTitleMappings.update', error);
  }
};

export const DELETE: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await deleteMapping(
      connection.db,
      kindOf(context.url.searchParams.get('kind')),
      context.params.id ?? '',
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.jobTitleMappings.delete', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH or DELETE');
