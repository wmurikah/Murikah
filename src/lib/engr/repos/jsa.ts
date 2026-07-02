/**
 * Read the latest job safety analysis for a work order. Org-scoped. The write
 * happens in the state machine (submit_jsa_request_arrival).
 */
import type { Client } from '@libsql/client/web';

export interface JsaRecord {
  id: string;
  contentJson: string;
  submittedAt: string | null;
  arrivalRequestedAt: string | null;
}

export async function getLatestJsa(
  db: Client,
  orgId: string,
  workOrderId: string,
): Promise<JsaRecord | null> {
  const res = await db.execute({
    sql: `SELECT id, content_json, submitted_at, arrival_requested_at
            FROM job_safety_analyses
           WHERE org_id = ? AND work_order_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, workOrderId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    contentJson: String(row.content_json),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    arrivalRequestedAt: row.arrival_requested_at == null ? null : String(row.arrival_requested_at),
  };
}
