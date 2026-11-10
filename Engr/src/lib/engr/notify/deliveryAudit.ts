/**
 * Append-only delivery transitions in the existing audit_logs table.
 * Notification bodies and addresses (which can contain authentication links)
 * must never be copied into an audit payload.
 *
 * The notifications table remains the delivery state/source of truth. A failed
 * audit write must not cause an already-sent external message to be sent twice.
 */
import type { SqlExecutor } from '../notify';

export type NotificationAuditEvent =
  | 'sent'
  | 'failed'
  | 'deferred'
  | 'retry_queued'
  | 'provider_delivered'
  | 'provider_failed';

export interface NotificationEventInput {
  notificationId: string;
  orgId?: string;
  actorUserId?: string | null;
  event: NotificationAuditEvent;
  status: 'SENT' | 'FAILED' | 'QUEUED' | 'DELIVERED';
  reason?: string | null;
}

function safeReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[link withheld]')
    .replace(/(?:token|secret|api[_-]?key)=[^\s;&]+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 400);
}

/** A single INSERT ... SELECT retains exact notification/tenant identity. */
export async function recordNotificationEvent(
  db: SqlExecutor,
  input: NotificationEventInput,
): Promise<void> {
  const res = await db.execute({
    sql: `INSERT INTO audit_logs
            (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          SELECT n.org_id, ?, ?, 'notification', n.id,
                 json_object(
                   'status', ?, 'reason', ?,
                   'channel', n.channel, 'templateKey', n.template_key,
                   'subject', n.subject,
                   'recipientType',
                     CASE WHEN n.recipient_user_id IS NOT NULL THEN 'user'
                          WHEN n.recipient_contractor_id IS NOT NULL THEN 'contractor'
                          WHEN n.recipient_technician_id IS NOT NULL THEN 'technician'
                          ELSE 'unknown' END,
                   'recipientId',
                     COALESCE(n.recipient_user_id, n.recipient_contractor_id,
                              n.recipient_technician_id))
            FROM notifications n
           WHERE n.id = ? AND (? IS NULL OR n.org_id = ?)`,
    args: [
      input.actorUserId ?? null,
      `notification.${input.event}`,
      input.status,
      safeReason(input.reason),
      input.notificationId,
      input.orgId ?? null,
      input.orgId ?? null,
    ],
  });
  if (res.rowsAffected !== 1) throw new Error('Cannot record delivery audit event for missing notification.');
}
