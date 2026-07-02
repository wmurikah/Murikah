/**
 * Engineer request-lifecycle actions and the data behind the assign panel.
 * Accept and reject move service_requests.status under an optimistic guard and
 * write an audit row. Org-scoped, and the acting engineer comes from the session.
 */
import type { Client } from '@libsql/client/web';

export interface RequestAssignmentInfo {
  id: string;
  stationId: string;
  categoryId: string | null;
  status: string;
}

export interface SlaOption {
  id: string;
  name: string;
}

export type RequestActionResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'conflict'; message: string };

export async function getRequestAssignmentInfo(
  db: Client,
  orgId: string,
  id: string,
): Promise<RequestAssignmentInfo | null> {
  const res = await db.execute({
    sql: `SELECT id, station_id, category_id, status FROM service_requests
           WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    stationId: String(row.station_id),
    categoryId: row.category_id == null ? null : String(row.category_id),
    status: String(row.status),
  };
}

export async function listSlas(db: Client, orgId: string): Promise<SlaOption[]> {
  const res = await db.execute({
    sql: `SELECT id, name FROM slas WHERE org_id = ? ORDER BY is_default DESC, name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

export async function acceptRequest(
  db: Client,
  orgId: string,
  userId: string,
  requestId: string,
): Promise<RequestActionResult> {
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE service_requests
               SET status = 'ACCEPTED', assigned_engineer_id = ?, accepted_at = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'OPEN'`,
      args: [userId, now, now, requestId, orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'The request is not open.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'requests.accept', 'service_request', ?, ?)`,
      args: [orgId, userId, requestId, JSON.stringify({ status: 'ACCEPTED' })],
    });
    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function rejectRequest(
  db: Client,
  orgId: string,
  userId: string,
  requestId: string,
  reason: string,
): Promise<RequestActionResult> {
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE service_requests
               SET status = 'REJECTED', rejection_reason = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND status = 'OPEN'`,
      args: [reason || null, now, requestId, orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'The request is not open.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'requests.reject', 'service_request', ?, ?)`,
      args: [orgId, userId, requestId, JSON.stringify({ status: 'REJECTED', reason })],
    });
    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
