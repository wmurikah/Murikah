/**
 * Versioned record snapshots, written the same way for every import type.
 *
 * THE VERSION NUMBER IS GUARDED BY THE DATABASE, NOT BY A READ.
 * The candidate is MAX(version_no) + 1, and UNIQUE(entity_type, entity_id,
 * version_no) is what actually guarantees it. A concurrent commit that takes
 * the same number makes this insert fail; the loop reads the new maximum and
 * tries again, so nobody ever holds two snapshots with one version.
 *
 * THE POINTER MOVES LAST. `latest_snapshot_id` on the business record is
 * updated inside the same transaction as the insert, so a reader never sees
 * a pointer to a snapshot that is not there, and never sees a current
 * snapshot the pointer has not caught up with.
 */
import type { Client } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';

export interface SnapshotTarget {
  /** The record_snapshots.entity_type value, for example SALES_ORDER. */
  entityType: string;
  /** The business table carrying latest_snapshot_id, for example sales_orders. */
  table: string;
  /** That table's primary key column, for example sales_order_id. */
  idColumn: string;
}

export const SALES_ORDER_SNAPSHOT: SnapshotTarget = {
  entityType: 'SALES_ORDER',
  table: 'sales_orders',
  idColumn: 'sales_order_id',
};

export const PURCHASE_ORDER_SNAPSHOT: SnapshotTarget = {
  entityType: 'PURCHASE_ORDER',
  table: 'purchase_orders',
  idColumn: 'purchase_order_id',
};

export async function insertSnapshot(
  db: Client,
  target: SnapshotTarget,
  entityId: string,
  sourceKey: string,
  rowHash: string,
  snapshotJson: string,
  batchId: string,
  now: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await db.execute({
      sql: `SELECT COALESCE(MAX(version_no), 0) AS v FROM record_snapshots
            WHERE entity_type = ? AND entity_id = ?`,
      args: [target.entityType, entityId],
    });
    const version = Number(current.rows[0]?.v ?? 0) + 1;
    const snapshotId = newId('SNAP');
    try {
      await db.batch(
        [
          {
            sql: `UPDATE record_snapshots SET is_current = 0
                  WHERE entity_type = ? AND entity_id = ? AND is_current = 1`,
            args: [target.entityType, entityId],
          },
          {
            sql: `INSERT INTO record_snapshots
                    (snapshot_id, entity_type, entity_id, import_batch_id, source_record_key,
                     version_no, row_hash, snapshot_json, captured_at, is_current)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            args: [
              snapshotId,
              target.entityType,
              entityId,
              batchId,
              sourceKey,
              version,
              rowHash,
              snapshotJson,
              now,
            ],
          },
          {
            sql: `UPDATE ${target.table} SET latest_snapshot_id = ? WHERE ${target.idColumn} = ?`,
            args: [snapshotId, entityId],
          },
        ],
        'write',
      );
      return snapshotId;
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(String(error))) throw error;
      // A concurrent commit took this version. Read again and retry.
    }
  }
  throw new Error('Could not allocate a snapshot version after five attempts.');
}
