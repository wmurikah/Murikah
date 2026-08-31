/**
 * GET and POST /api/admin/job-title-mappings on cms.murikah.com.
 *
 * The catalogue of what a job title USUALLY comes with. `?kind=ACCESS` reads
 * the access role defaults, `?kind=WORKFLOW` the workflow role defaults; a
 * POST creates one of either, named by `kind` in the body.
 *
 * ADMIN.ROLES.MANAGE, because deciding that Finance Manager should normally
 * carry the Finance Approver role is deciding what access that title suggests,
 * and the person who administers people is not necessarily the person who
 * administers access. Writing a mapping still grants nobody anything — no
 * user's roles change — but it shapes what the next administrator is offered,
 * which is a capability that belongs with the role permission.
 */
import type { APIRoute } from 'astro';
import { requireRolesManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateMapping } from '../../../../../lib/cms/admin/jobTitleMappingInput.ts';
import {
  createMapping,
  listMappings,
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

/** ACCESS unless the caller says WORKFLOW. An unknown value is not a third table. */
function kindOf(value: string | null): MappingKind {
  return String(value ?? '').toUpperCase() === 'WORKFLOW' ? 'WORKFLOW' : 'ACCESS';
}

export const GET: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const kind = kindOf(context.url.searchParams.get('kind'));
    return ok({ kind, items: await listMappings(connection.db, kind) });
  } catch (error) {
    return serverError('admin.jobTitleMappings.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const raw = await readJson(context.request);
  const parsed = validateMapping(raw);
  if (!parsed.ok) return invalid(parsed.errors);
  const kind = kindOf(
    typeof raw === 'object' && raw !== null
      ? String((raw as Record<string, unknown>).kind ?? '')
      : '',
  );

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await createMapping(
      connection.db,
      kind,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.jobTitleMappings.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
