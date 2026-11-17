import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

/**
 * Historical tracker records are intentionally separate from live work_orders:
 * the source does not establish approval, dispatch, completion or closure.
 * No active queues, maker-checker workflow, alerts or supplier billing are
 * created by loading historical data.
 */
export const legacyWorkOrderArchive: Migration = {
  id: '012',
  description: 'Read-only historical work order archive',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    await db.executeMultiple(`CREATE TABLE IF NOT EXISTS legacy_work_order_history (
 id TEXT PRIMARY KEY,
 org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
 source_file TEXT NOT NULL,
 source_row INTEGER NOT NULL,
 reported_date TEXT,
 reported_raw TEXT,
 contractor_source TEXT,
 location_source TEXT,
 suggested_location TEXT,
 mapping_class TEXT NOT NULL DEFAULT 'REVIEW',
 station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
 wo_reference_source TEXT,
 wo_number INTEGER,
 description TEXT NOT NULL,
 expected_closure_date TEXT,
 expected_closure_raw TEXT,
 quality_flags TEXT,
 review_state TEXT NOT NULL DEFAULT 'UNREVIEWED'
   CHECK (review_state IN ('UNREVIEWED','MATCHED','REVIEW_REQUIRED','EXCLUDED')),
 imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE (org_id, source_file, source_row)
);
CREATE INDEX IF NOT EXISTS ix_legacy_wo_org_date
 ON legacy_work_order_history(org_id, reported_date, source_row);
CREATE INDEX IF NOT EXISTS ix_legacy_wo_station
 ON legacy_work_order_history(org_id, station_id);
CREATE INDEX IF NOT EXISTS ix_legacy_wo_ref
 ON legacy_work_order_history(org_id, wo_number);`);
  },
};
