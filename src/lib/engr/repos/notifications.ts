/**
 * Reads and small writes for the notifications console and the in-app centre.
 * Org-scoped throughout. The dispatcher owns delivery; these only report and let
 * a recipient mark a row read or an operator retry a failed row.
 */
import type { Client } from '@libsql/client/web';

// A recipient's own IN_APP rows: addressed directly, or to a contractor or
// technician whose portal account they are.
const OWN_RECIPIENT = `(
  recipient_user_id = ?
  OR recipient_contractor_id IN (SELECT id FROM contractors WHERE org_id = ? AND portal_user_id = ?)
  OR recipient_technician_id IN (SELECT id FROM technicians WHERE org_id = ? AND portal_user_id = ?)
)`;

export interface NotificationStats {
  queued: number;
  sent: number;
  failed: number;
}

/** Counts by status for rows created since the given instant (today, in EAT). */
export async function getStatsSince(
  db: Client,
  orgId: string,
  sinceIso: string,
): Promise<NotificationStats> {
  const res = await db.execute({
    sql: `SELECT status, COUNT(*) AS n FROM notifications
           WHERE org_id = ? AND created_at >= ?
        GROUP BY status`,
    args: [orgId, sinceIso],
  });
  const stats: NotificationStats = { queued: 0, sent: 0, failed: 0 };
  for (const row of res.rows) {
    const status = String(row.status);
    const n = Number(row.n ?? 0);
    if (status === 'QUEUED') stats.queued = n;
    else if (status === 'SENT') stats.sent = n;
    else if (status === 'FAILED') stats.failed = n;
  }
  return stats;
}

export interface FailedRow {
  id: string;
  channel: string;
  subject: string | null;
  error: string | null;
  createdAt: string;
}

export async function listRecentFailed(
  db: Client,
  orgId: string,
  limit = 50,
): Promise<FailedRow[]> {
  const res = await db.execute({
    sql: `SELECT id, channel, subject, error, created_at
            FROM notifications
           WHERE org_id = ? AND status = 'FAILED'
        ORDER BY created_at DESC LIMIT ?`,
    args: [orgId, Math.max(1, Math.min(limit, 200))],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    channel: String(row.channel),
    subject: row.subject == null ? null : String(row.subject),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
  }));
}

/** Flip a FAILED row back to QUEUED so the dispatcher retries it. */
export async function retryFailed(db: Client, orgId: string, id: string): Promise<boolean> {
  const res = await db.execute({
    sql: `UPDATE notifications SET status = 'QUEUED', error = NULL, sent_at = NULL
           WHERE id = ? AND org_id = ? AND status = 'FAILED'`,
    args: [id, orgId],
  });
  return res.rowsAffected === 1;
}

export interface InAppRow {
  id: string;
  subject: string | null;
  body: string | null;
  status: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

/** The current user's IN_APP notifications, newest first. */
export async function listInApp(
  db: Client,
  orgId: string,
  userId: string,
  limit = 100,
): Promise<InAppRow[]> {
  const res = await db.execute({
    sql: `SELECT id, subject, body, status, entity_type, entity_id, created_at
            FROM notifications
           WHERE org_id = ? AND channel = 'IN_APP' AND status IN ('QUEUED', 'SENT', 'READ')
             AND ${OWN_RECIPIENT}
        ORDER BY created_at DESC LIMIT ?`,
    args: [orgId, userId, orgId, userId, orgId, userId, Math.max(1, Math.min(limit, 200))],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    subject: row.subject == null ? null : String(row.subject),
    body: row.body == null ? null : String(row.body),
    status: String(row.status),
    entityType: row.entity_type == null ? null : String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    createdAt: String(row.created_at),
  }));
}

/**
 * Reconcile a row from a provider delivery receipt. The webhook has no tenant
 * session, so this updates by the notification's own id (an unguessable key)
 * under the shared-secret gate, not by org. A failed receipt moves a sent row to
 * FAILED with the provider's reason; a delivered receipt clears any transient
 * note. Only a currently SENT row is touched.
 */
export async function applyDeliveryReceipt(
  db: Client,
  id: string,
  delivered: boolean,
  reason: string | null,
): Promise<boolean> {
  if (delivered) {
    const res = await db.execute({
      sql: `UPDATE notifications SET error = NULL WHERE id = ? AND status = 'SENT'`,
      args: [id],
    });
    return res.rowsAffected === 1;
  }
  const res = await db.execute({
    sql: `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ? AND status = 'SENT'`,
    args: [reason ?? 'provider reported delivery failure', id],
  });
  return res.rowsAffected === 1;
}

/** Mark one of the user's own IN_APP rows READ. */
export async function markRead(
  db: Client,
  orgId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `UPDATE notifications SET status = 'READ'
           WHERE id = ? AND org_id = ? AND channel = 'IN_APP' AND status IN ('QUEUED', 'SENT')
             AND ${OWN_RECIPIENT}`,
    args: [id, orgId, userId, orgId, userId, orgId, userId],
  });
  return res.rowsAffected === 1;
}
