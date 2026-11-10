import type { Client } from '@libsql/client/web';

export interface AuditRow {
  id: string;
  actorName: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

/** Recent organisation audit activity. Payload JSON is deliberately omitted
 * from the general UI because it may contain operational identifiers. */
export async function listAuditRows(db: Client, orgId: string, limit = 250): Promise<AuditRow[]> {
  const result = await db.execute({
    sql: `SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at,
                 COALESCE(u.full_name, 'System') AS actor_name
            FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE a.org_id = ? AND (a.entity_type IS NULL OR a.entity_type <> 'notification')
        ORDER BY a.created_at DESC
           LIMIT ?`,
    args: [orgId, Math.min(Math.max(limit, 1), 1000)],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    actorName: String(row.actor_name),
    action: String(row.action),
    entityType: row.entity_type == null ? null : String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    createdAt: String(row.created_at),
  }));
}


/** Delivery details are privileged. The route checks both audit.view and
 * notifications.monitor before calling this query.
 *
 * The audit stream is append-only for future transitions. Older notifications
 * without audit events are presented from their current persisted state, so
 * existing failures remain discoverable after removing the console.
 */
export interface NotificationAuditRow {
  id: string;
  notificationId: string;
  occurredAt: string;
  actorName: string;
  action: string;
  channel: string;
  recipient: string;
  templateKey: string | null;
  subject: string | null;
  status: string;
  reason: string | null;
  currentStatus: string;
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
function auditDetails(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const object: unknown = JSON.parse(raw);
    return object !== null && typeof object === 'object' && !Array.isArray(object)
      ? object as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
const RECIPIENT_JOINS = `
      LEFT JOIN users ru ON ru.id = n.recipient_user_id AND ru.org_id = n.org_id
      LEFT JOIN contractors co ON co.id = n.recipient_contractor_id AND co.org_id = n.org_id
      LEFT JOIN technicians te ON te.id = n.recipient_technician_id AND te.org_id = n.org_id`;

/** All records are tenant-scoped and results are capped by the requested limit. */
export async function listNotificationAuditRows(
  db: Client,
  orgId: string,
  limit = 200,
): Promise<NotificationAuditRow[]> {
  const cap = Math.max(1, Math.min(limit, 500));
  const [logged, existing] = await db.batch(
    [
      {
        sql: `SELECT a.id, a.entity_id AS notification_id, a.action, a.after_json,
                     a.created_at AS occurred_at,
                     COALESCE(au.full_name, 'System') AS actor_name,
                     n.channel, n.template_key, n.subject, n.status AS current_status,
                     n.error AS current_error,
                     COALESCE(ru.full_name, co.name, te.full_name) AS recipient_name
                FROM audit_logs a
           LEFT JOIN users au ON au.id = a.actor_user_id
           LEFT JOIN notifications n ON n.id = a.entity_id AND n.org_id = a.org_id
                     ${RECIPIENT_JOINS}
               WHERE a.org_id = ? AND a.entity_type = 'notification'
                 AND a.action LIKE 'notification.%'
            ORDER BY a.created_at DESC, a.id DESC
               LIMIT ?`,
        args: [orgId, cap],
      },
      {
        sql: `SELECT n.id, n.channel, n.template_key, n.subject, n.status, n.error,
                     COALESCE(n.sent_at, n.created_at) AS occurred_at,
                     COALESCE(ru.full_name, co.name, te.full_name) AS recipient_name
                FROM notifications n
                     ${RECIPIENT_JOINS}
               WHERE n.org_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM audit_logs a
                    WHERE a.org_id = n.org_id AND a.entity_type = 'notification'
                      AND a.entity_id = n.id AND a.action LIKE 'notification.%'
                 )
            ORDER BY n.created_at DESC, n.id DESC
               LIMIT ?`,
        args: [orgId, cap],
      },
    ],
    'read',
  );
  const rows: NotificationAuditRow[] = logged.rows.map((r) => {
    const snapshot = auditDetails(r.after_json);
    const recipientType = nullable(snapshot.recipientType);
    const recipientId = nullable(snapshot.recipientId);
    return {
      id: String(r.id),
      notificationId: String(r.notification_id),
      occurredAt: String(r.occurred_at),
      actorName: String(r.actor_name),
      action: String(r.action).replace(/^notification\./, '').replaceAll('_', ' '),
      channel: nullable(snapshot.channel) ?? nullable(r.channel) ?? 'Unknown',
      recipient: nullable(r.recipient_name) ??
        (recipientType && recipientId ? `${recipientType} ${recipientId}` : 'Recipient unavailable'),
      templateKey: nullable(snapshot.templateKey) ?? nullable(r.template_key),
      subject: nullable(snapshot.subject) ?? nullable(r.subject),
      status: nullable(snapshot.status) ?? nullable(r.current_status) ?? 'Unknown',
      reason: nullable(snapshot.reason),
      currentStatus: nullable(r.current_status) ?? 'Unknown',
    };
  });
  for (const r of existing.rows) {
    rows.push({
      id: `existing:${String(r.id)}`,
      notificationId: String(r.id),
      occurredAt: String(r.occurred_at),
      actorName: 'System',
      action: 'Recorded notification',
      channel: String(r.channel),
      recipient: nullable(r.recipient_name) ?? 'Recipient unavailable',
      templateKey: nullable(r.template_key),
      subject: nullable(r.subject),
      status: String(r.status),
      reason: nullable(r.error),
      currentStatus: String(r.status),
    });
  }
  rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  return rows.slice(0, cap);
}
