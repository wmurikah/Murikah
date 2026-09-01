/**
 * DELETE /api/data/imports/{batchId}/delete — remove a batch that never wrote
 * a canonical record.
 *
 * A SEPARATE ENDPOINT FROM THE TWO RETRY ACTIONS, because it is a separate and
 * irreversible act. GET returns the plan — what goes, what stays and whether
 * it is permitted — so the confirmation can state it before anything happens.
 *
 * The refusal is a 200 carrying the reason rather than a 403, because "this
 * batch wrote 662 records" is an answer to the question, not a failure to
 * answer it, and the screen has to render the sentence either way.
 */
import type { APIRoute } from 'astro';
import { requireImportUpload, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import type { ImportType } from '../../../../../../lib/cms/import/uploadCentre.ts';
import { planBatchDeletion, deleteBatch } from '../../../../../../lib/cms/import/batchAdmin.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

async function authorise(
  context: Parameters<APIRoute>[0],
  db: Parameters<typeof planBatchDeletion>[0],
  batchId: string,
) {
  const found = await db.execute({
    sql: `SELECT import_type FROM import_batches WHERE import_batch_id = ?`,
    args: [batchId],
  });
  const row = found.rows[0];
  if (row === undefined) return { ok: false as const, response: notFound() };
  return requireImportUpload(context, String(row.import_type) as ImportType);
}

/** What a delete would take and what it would leave. Nothing is written. */
export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const auth = await authorise(context, connection.db, batchId);
    if (!auth.ok) return auth.response;
    const plan = await planBatchDeletion(connection.db, batchId);
    if (plan === null) return notFound();
    return ok(plan);
  } catch (error) {
    return serverError('data.imports.delete.plan', error);
  }
};

export const POST: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const auth = await authorise(context, connection.db, batchId);
    if (!auth.ok) return auth.response;
    return ok(
      await deleteBatch(connection.db, batchId, writeContext(context.request, auth.principal)),
    );
  } catch (error) {
    return serverError('data.imports.delete', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET, POST');
