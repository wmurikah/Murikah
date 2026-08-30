/**
 * GET and POST /api/admin/source-identities on cms.murikah.com.
 *
 * Maps an external username, such as an Oracle account, to a user who already
 * exists. There is no create-user path here and there never will be: a mapping
 * that could bring an account into existence would be a way to create a system
 * user without going through the invitation flow.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateSourceIdentity } from '../../../../../lib/cms/admin/userInput.ts';
import { listSourceIdentities, mapSourceIdentity } from '../../../../../lib/cms/repos/userAdmin.ts';
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
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const userId = context.url.searchParams.get('userId') ?? undefined;
    return ok({ items: await listSourceIdentities(connection.db, userId) });
  } catch (error) {
    return serverError('admin.sourceIdentities.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateSourceIdentity(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await mapSourceIdentity(
      connection.db,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.sourceIdentities.map', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
