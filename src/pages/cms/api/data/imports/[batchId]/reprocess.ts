/**
 * POST /api/data/imports/{batchId}/reprocess on cms.murikah.com.
 *
 * Run an existing batch again from the beginning: re-read the stored workbook,
 * re-validate it, rebuild its rows and its landing, and leave it in a terminal
 * state. The batch keeps its identifier, its uploader, its upload timestamp
 * and its file hash, because it is the same batch run again rather than a
 * second upload. The hash rule is therefore not consulted; see
 * `reprocessBatchId` in the importers.
 *
 * Nothing canonical is written. A reprocess ends where a first run would end,
 * and the commit stays a separate, deliberate act.
 */
import type { APIRoute } from 'astro';
import { requireImportUpload, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { reprocessBatch, type ImportType } from '../../../../../../lib/cms/import/uploadCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const found = await connection.db.execute({
      sql: `SELECT import_type FROM import_batches WHERE import_batch_id = ?`,
      args: [batchId],
    });
    const batch = found.rows[0];
    if (batch === undefined) return notFound();
    // Reprocessing rebuilds a batch, so it needs the same permission uploading
    // that data type needs, not merely permission to look at imports.
    const auth = requireImportUpload(context, String(batch.import_type) as ImportType);
    if (!auth.ok) return auth.response;
    const outcome = await reprocessBatch(
      connection.db,
      batchId,
      writeContext(context.request, auth.principal),
    );
    return ok(outcome, outcome.ok ? 200 : 422);
  } catch (error) {
    return serverError('data.imports.reprocess', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
