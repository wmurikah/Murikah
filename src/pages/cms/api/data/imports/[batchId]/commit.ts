/**
 * POST /api/data/imports/{batchId}/commit on cms.murikah.com.
 *
 * The separate, deliberate act that turns a validated batch into sales or
 * purchase orders. The importer commits document by document, so a broken
 * row leaves no half-written document, and the response says what imported
 * and what did not rather than "Upload successful".
 */
import type { APIRoute } from 'astro';
import { requireImportUpload, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { commitBatch, type ImportType } from '../../../../../../lib/cms/import/uploadCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const found = await connection.db.execute({
      sql: `SELECT import_type, status FROM import_batches WHERE import_batch_id = ?`,
      args: [batchId],
    });
    const batch = found.rows[0];
    if (batch === undefined) return notFound();
    // The permission is the one for this batch's own data type, resolved from
    // the batch rather than from anything the caller sent.
    const auth = requireImportUpload(context, String(batch.import_type) as ImportType);
    if (!auth.ok) return auth.response;
    return ok(
      await commitBatch(connection.db, batchId, writeContext(context.request, auth.principal)),
    );
  } catch (error) {
    return serverError('data.imports.commit', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
