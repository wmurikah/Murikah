/**
 * Job card reads and the rate-item pick list used to price spares. Org-scoped.
 * The job card and its spares are written by the state machine
 * (submit_jobcard_request_closure); money stays in minor units here.
 */
import type { Client } from '@libsql/client/web';

export interface JobCardRecord {
  id: string;
  diagnosis: string | null;
  rootCause: string | null;
  repairDone: string | null;
  status: string;
}

export interface SpareRow {
  id: string;
  description: string;
  qty: number;
  unitRateMinor: number | null;
  currency: string;
}

export interface RateItemOption {
  id: string;
  description: string;
  unitRateMinor: number;
  currency: string;
}

export async function getJobCard(
  db: Client,
  orgId: string,
  workOrderId: string,
): Promise<JobCardRecord | null> {
  const res = await db.execute({
    sql: `SELECT id, diagnosis, root_cause, repair_done, status
            FROM job_cards
           WHERE org_id = ? AND work_order_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, workOrderId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    diagnosis: row.diagnosis == null ? null : String(row.diagnosis),
    rootCause: row.root_cause == null ? null : String(row.root_cause),
    repairDone: row.repair_done == null ? null : String(row.repair_done),
    status: String(row.status),
  };
}

export async function listSpares(
  db: Client,
  orgId: string,
  jobCardId: string,
): Promise<SpareRow[]> {
  const res = await db.execute({
    sql: `SELECT id, description, qty, unit_rate_minor, currency
            FROM job_card_spares WHERE org_id = ? AND job_card_id = ? ORDER BY created_at`,
    args: [orgId, jobCardId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    description: String(row.description),
    qty: Number(row.qty),
    unitRateMinor: row.unit_rate_minor == null ? null : Number(row.unit_rate_minor),
    currency: String(row.currency),
  }));
}

// Predefined-rate spare options for the work order: active rate-card items whose
// category matches the work order (or is unset).
export async function listRateItemsForWorkOrder(
  db: Client,
  orgId: string,
  workOrderId: string,
): Promise<RateItemOption[]> {
  const woRes = await db.execute({
    sql: `SELECT category_id FROM work_orders WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [workOrderId, orgId],
  });
  const categoryId = woRes.rows[0]?.category_id == null ? null : String(woRes.rows[0].category_id);
  const res = await db.execute({
    sql: `SELECT ri.id, ri.description, ri.unit_rate_minor, ri.currency
            FROM rate_items ri
            JOIN rate_cards rc ON rc.id = ri.rate_card_id
           WHERE ri.org_id = ? AND rc.status = 'ACTIVE'
             AND (ri.category_id IS NULL OR ri.category_id = ?)
        ORDER BY ri.description LIMIT 200`,
    args: [orgId, categoryId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    description: String(row.description),
    unitRateMinor: Number(row.unit_rate_minor),
    currency: String(row.currency),
  }));
}
