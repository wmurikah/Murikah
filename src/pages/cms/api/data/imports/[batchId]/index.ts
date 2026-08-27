/**
 * GET /api/data/imports/{batchId} on cms.murikah.com.
 *
 * One batch: its counters, its exception queues and its rows. Rows and
 * documents are reported separately, never blended into one percentage.
 */
import type { APIRoute } from 'astro';
import { requireImportsView } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import {
  exceptionQueues,
  listBatches,
  escapeForDisplay,
} from '../../../../../../lib/cms/import/uploadCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireImportsView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const batchId = context.params.batchId ?? '';
  try {
    const batch = (await listBatches(connection.db, 200)).find((b) => b.batchId === batchId);
    if (batch === undefined) return notFound();
    const rows = await connection.db.execute({
      sql: `SELECT import_row_id, source_row_number, source_record_key, row_status,
              error_message, entity_id, imported_at
            FROM import_rows WHERE import_batch_id = ?
            ORDER BY source_row_number LIMIT 500`,
      args: [batchId],
    });
    return ok({
      batch,
      queues: await exceptionQueues(connection.db, batchId),
      rows: rows.rows.map((raw) => {
        const row = raw as unknown as Record<string, unknown>;
        return {
          importRowId: String(row.import_row_id),
          sourceRowNumber: Number(row.source_row_number),
          sourceRecordKey: row.source_record_key === null ? null : String(row.source_record_key),
          rowStatus: String(row.row_status),
          errorMessage:
            row.error_message === null ? null : escapeForDisplay(String(row.error_message)),
          entityId: row.entity_id === null ? null : String(row.entity_id),
          importedAt: row.imported_at === null ? null : String(row.imported_at),
        };
      }),
    });
  } catch (error) {
    return serverError('data.imports.detail', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
