/**
 * Read the latest site arrival for a work order. Org-scoped. The pending row is
 * opened, and later confirmed, by the state machine.
 */
import type { Client } from '@libsql/client/web';

export interface ArrivalRecord {
  id: string;
  confirmationStatus: string;
  confirmedAt: string | null;
}

export async function getLatestArrival(
  db: Client,
  orgId: string,
  workOrderId: string,
): Promise<ArrivalRecord | null> {
  const res = await db.execute({
    sql: `SELECT id, confirmation_status, confirmed_at
            FROM site_arrivals
           WHERE org_id = ? AND work_order_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, workOrderId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    confirmationStatus: String(row.confirmation_status),
    confirmedAt: row.confirmed_at == null ? null : String(row.confirmed_at),
  };
}
