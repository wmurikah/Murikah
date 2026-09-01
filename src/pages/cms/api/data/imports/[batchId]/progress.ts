/**
 * GET /api/data/imports/{batchId}/progress — the phase and the counts.
 *
 * ONE ROUND TRIP, because this is polled. It returns exactly what the page
 * renders on the server, so a reload and a poll cannot disagree: there is one
 * query and both callers use it.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { requireImportsView } from '../../../../../../lib/cms/admin/guard.ts';
import { importProgress } from '../../../../../../lib/cms/import/progress.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = requireImportsView(context);
  if (!auth.ok) return auth.response;
  try {
    const progress = await importProgress(connection.db, context.params.batchId ?? '');
    if (progress === null) return notFound();
    return ok(progress);
  } catch (error) {
    return serverError('data.imports.progress', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
