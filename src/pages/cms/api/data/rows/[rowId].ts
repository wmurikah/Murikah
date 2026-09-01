/**
 * GET /api/data/rows/{rowId} on cms.murikah.com.
 *
 * The row inspector. The Upload Centre permission is enough to see that a
 * row exists and what happened to it; the source values inside need the
 * data type's own module access, and the response says so rather than
 * quietly returning an empty panel.
 */
import type { APIRoute } from 'astro';
import { requireImportsView } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { inspectRow } from '../../../../../lib/cms/import/uploadCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireImportsView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const row = await inspectRow(
      connection.db,
      context.params.rowId ?? '',
      auth.principal.user.permissions,
    );
    return row === null ? notFound() : ok({ row });
  } catch (error) {
    return serverError('data.rows.inspect', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
