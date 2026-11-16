/** Governed hard deletion for evidence whose retention deadline has passed. */
import type { Client } from '@libsql/client/web';
import { isUnderLegalHold } from '@grc/repos/governance';
import { getR2Backend } from './r2';

interface DueFile {
  queueId: string;
  fileId: string;
  backend: string;
  storageKey: string | null;
}

export interface PurgeResult {
  considered: number;
  purged: number;
  held: number;
}

async function dueFiles(db: Client, now: string, limit: number): Promise<DueFile[]> {
  const res = await db.execute({
    sql: `SELECT dq.queue_id, dq.entity_id AS file_id,
                 COALESCE(f.storage_backend, '') AS storage_backend, f.storage_key
            FROM deletion_queue dq
            LEFT JOIN files f ON f.file_id = dq.entity_id
           WHERE dq.entity_type = 'file' AND dq.processed_at IS NULL
             AND dq.hard_delete_after <= ?
        ORDER BY dq.hard_delete_after, dq.queue_id
           LIMIT ?`,
    args: [now, limit],
  });
  return res.rows.map((r) => ({
    queueId: String(r.queue_id),
    fileId: String(r.file_id),
    backend: String(r.storage_backend ?? ''),
    storageKey: r.storage_key == null ? null : String(r.storage_key),
  }));
}

async function fileIsHeld(db: Client, fileId: string): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT entity_type, entity_id FROM file_attachments WHERE file_id = ?`,
    args: [fileId],
  });
  for (const row of res.rows) {
    if (await isUnderLegalHold(db, String(row.entity_type), String(row.entity_id))) return true;
  }
  return false;
}

/**
 * Purge due evidence. R2 bytes are deleted before metadata. Drive is a
 * read-through source owned by the customer; after the retention date its GRC
 * attachment and metadata are removed, while deletion in Drive remains the
 * customer's own retention responsibility.
 */
export async function runEvidencePurge(
  db: Client,
  now = new Date(),
  limit = 50,
): Promise<PurgeResult> {
  const due = await dueFiles(db, now.toISOString(), limit);
  const r2 = getR2Backend();
  let purged = 0;
  let held = 0;

  for (const file of due) {
    if (await fileIsHeld(db, file.fileId)) {
      held += 1;
      continue;
    }

    if (file.backend === 'r2' && file.storageKey) {
      if (!r2) throw new Error(`R2 is not configured; cannot purge evidence ${file.fileId}.`);
      await r2.remove({ backend: 'r2', key: file.storageKey });
    }

    const processedAt = new Date().toISOString();
    await db.batch(
      [
        { sql: `DELETE FROM file_attachments WHERE file_id = ?`, args: [file.fileId] },
        { sql: `DELETE FROM files WHERE file_id = ?`, args: [file.fileId] },
        {
          sql: `UPDATE deletion_queue SET processed_at = ?
                 WHERE queue_id = ? AND processed_at IS NULL`,
          args: [processedAt, file.queueId],
        },
      ],
      'write',
    );
    purged += 1;
  }

  return { considered: due.length, purged, held };
}
