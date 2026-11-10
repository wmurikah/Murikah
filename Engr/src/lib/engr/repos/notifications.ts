/**
 * Reads and small writes for the notifications console and the in-app centre.
 * Org-scoped throughout. The dispatcher owns delivery; these only report and let
 * a recipient mark a row read or an operator retry a failed row.
 */
import type { Client } from '@libsql/client/web';
import { recordNotificationEvent } from '../notify/deliveryAudit';

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
  retryable: boolean;
}

export async function listRecentFailed(
  db: Client,
  orgId: string,
  limit = 50,
): Promise<FailedRow[]> {
  const res = await db.execute({
    sql: `SELECT n.id, n.channel, n.subject, n.error, n.created_at,
                 CASE WHEN COALESCE(n.template_key, '') NOT IN ('auth.invitation','auth.password.reset')
                      THEN 1 ELSE EXISTS (
                        SELECT 1 FROM auth_tokens t
                         WHERE t.org_id = n.org_id AND t.user_id = n.recipient_user_id
                           AND t.purpose = CASE n.template_key
                             WHEN 'auth.invitation' THEN 'INVITE' ELSE 'RESET' END
                           AND t.token_hash = substr(n.body, 26, 64)
                           AND t.used_at IS NULL AND t.expires_at > ?
                      ) END AS retryable
            FROM notifications n
           WHERE n.org_id = ? AND n.status = 'FAILED'
        ORDER BY created_at DESC LIMIT ?`,
    args: [new Date().toISOString(), orgId, Math.max(1, Math.min(limit, 200))],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    channel: String(row.channel),
    subject: row.subject == null ? null : String(row.subject),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    retryable: Number(row.retryable) === 1,
  }));
}

/** Flip a FAILED row back to QUEUED so the dispatcher retries it. */
export async function retryFailed(
  db: Client,
  orgId: string,
  id: string,
  actorUserId?: string,
): Promise<boolean> {
  const tx = await db.transaction('write');
  try {
    const res = await tx.execute({
      sql: `UPDATE notifications SET status = 'QUEUED', error = NULL, sent_at = NULL
           WHERE id = ? AND org_id = ? AND status = 'FAILED'
             AND (COALESCE(template_key, '') NOT IN ('auth.invitation','auth.password.reset')
                  OR EXISTS (
                    SELECT 1 FROM auth_tokens t
                     WHERE t.org_id = notifications.org_id
                       AND t.user_id = notifications.recipient_user_id
                       AND t.purpose = CASE notifications.template_key
                         WHEN 'auth.invitation' THEN 'INVITE' ELSE 'RESET' END
                       AND t.token_hash = substr(notifications.body, 26, 64)
                       AND t.used_at IS NULL AND t.expires_at > ?
                  ))`,
      args: [id, orgId, new Date().toISOString()],
    });
    if (res.rowsAffected !== 1) {
      await tx.rollback();
      return false;
    }
    await recordNotificationEvent(tx, {
      notificationId: id,
      orgId,
      actorUserId,
      event: 'retry_queued',
      status: 'QUEUED',
      reason: 'Authorised manual retry queued',
    });
    await tx.commit();
    return true;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
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
  const tx = await db.transaction('write');
  try {
    const res = await tx.execute({
      sql: delivered
        ? `UPDATE notifications SET error = NULL WHERE id = ? AND status = 'SENT'`
        : `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ? AND status = 'SENT'`,
      args: delivered ? [id] : [reason ?? 'provider reported delivery failure', id],
    });
    if (res.rowsAffected !== 1) {
      await tx.rollback();
      return false;
    }
    await recordNotificationEvent(tx, {
      notificationId: id,
      event: delivered ? 'provider_delivered' : 'provider_failed',
      status: delivered ? 'DELIVERED' : 'FAILED',
      reason: delivered ? null : reason ?? 'provider reported delivery failure',
    });
    await tx.commit();
    return true;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
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
