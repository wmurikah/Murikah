/**
 * POST /api/data/imports/{batchId}/revalidate on cms.murikah.com.
 *
 * Reprocess this batch's eligible unresolved rows after a mapping has been
 * made. The file is not sent again, which the hash rule would refuse anyway;
 * the batch keeps its identity and its provenance.
 */
import type { APIRoute } from 'astro';
import { requireImportUpload, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { revalidateBatch, type ImportType } from '../../../../../../lib/cms/import/uploadCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const found = await connection.db.execute({
      sql: `SELECT import_type FROM import_batches WHERE import_batch_id = ?`,
      args: [batchId],
    });
    const batch = found.rows[0];
    if (batch === undefined) return notFound();
    const auth = requireImportUpload(context, String(batch.import_type) as ImportType);
    if (!auth.ok) return auth.response;
    return ok(
      await revalidateBatch(connection.db, batchId, writeContext(context.request, auth.principal)),
    );
  } catch (error) {
    return serverError('data.imports.revalidate', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
