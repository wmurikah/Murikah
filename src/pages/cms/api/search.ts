/**
 * GET /api/search on cms.murikah.com.
 *
 * The security filter is inside each of the seven queries, so this endpoint
 * has nothing to filter and no opportunity to forget to. A caller with no
 * module permissions gets an empty result and a list of the groups they do
 * not hold, which is a fact about their own access and not about the data.
 *
 * A short query returns nothing rather than everything: one character
 * matches most of the database, and a search that returns four thousand rows
 * is a denial of service somebody types by accident.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../lib/cms/admin/crudRoute.ts';
import { requireSignedIn } from '../../../lib/cms/admin/guard.ts';
import { globalSearch } from '../../../lib/cms/search/globalSearch.ts';
import { methodNotAllowed, ok, serverError } from '../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await globalSearch(
      connection.db,
      auth.principal.user.userId,
      auth.principal.user.permissions,
      context.url.searchParams.get('q') ?? '',
    );
    return ok(result);
  } catch (error) {
    return serverError('search', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
