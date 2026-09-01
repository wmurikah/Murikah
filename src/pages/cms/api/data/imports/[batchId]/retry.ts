/**
 * POST /api/data/imports/{batchId}/retry — re-run the commit for a batch that
 * validated but failed to write.
 *
 * NOT REVALIDATE, WHICH IS A DIFFERENT ACT WITH A DIFFERENT ENDPOINT. This
 * writes canonical records; revalidate re-checks rows against master data and
 * writes none. Confusing the two on a screen is how an operator presses the
 * wrong one under pressure, so they are separate endpoints with separate
 * permissions checks and separate words.
 *
 * GET returns the three figures without writing anything, so the screen can
 * put them in front of a person before they decide.
 */
import type { APIRoute } from 'astro';
import { requireImportUpload, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { commitBatch, type ImportType } from '../../../../../../lib/cms/import/uploadCentre.ts';
import { previewRetry, retryImport } from '../../../../../../lib/cms/import/retry.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

/** The batch's own import type decides which permission is asked for. */
async function authorise(
  context: Parameters<APIRoute>[0],
  db: Parameters<typeof commitBatch>[0],
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

/** The figures, and nothing written. */
export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const auth = await authorise(context, connection.db, batchId);
    if (!auth.ok) return auth.response;
    const preview = await previewRetry(connection.db, batchId);
    if (preview === null) return notFound();
    return ok(preview);
  } catch (error) {
    return serverError('data.imports.retry.preview', error);
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
      await retryImport(
        connection.db,
        batchId,
        writeContext(context.request, auth.principal),
        commitBatch,
      ),
    );
  } catch (error) {
    return serverError('data.imports.retry', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET, POST');
