/**
 * GET /api/data/unresolved-actors on cms.murikah.com.
 *
 * The unresolved user queue: the names the source used, where they came
 * from, when they first appeared and how many rows wait on each.
 */
import type { APIRoute } from 'astro';
import { requireImportsView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { listUnresolvedActors } from '../../../../../lib/cms/import/uploadCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireImportsView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    return ok({ actors: await listUnresolvedActors(connection.db) });
  } catch (error) {
    return serverError('data.unresolvedActors.list', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
