/**
 * Notification enqueue. This prompt only queues notifications; the SMS and email
 * dispatcher and the in-app panel arrive in a later prompt. Rows are written with
 * status QUEUED. Channels come from org_settings (key notification_channels),
 * always including IN_APP so the in-app pipeline is visible.
 *
 * Recipients resolve into exactly one of the recipient columns. Everything is
 * org-scoped by the caller.
 */
import type { InStatement, ResultSet } from '@libsql/client/web';

// Both the libSQL Client and an open Transaction satisfy this, so enqueue can run
// standalone or inside a state-machine transaction.
export interface SqlExecutor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

export type RecipientType = 'user' | 'contractor' | 'technician';

export interface EnqueueParams {
  recipientType: RecipientType;
  recipientId: string;
  templateKey: string;
  subject: string;
  body: string;
  entityType: string;
  entityId: string;
}

const IN_APP = 'IN_APP';
const VALID_CHANNELS = new Set(['IN_APP', 'SMS', 'EMAIL']);

async function resolveChannels(db: SqlExecutor, orgId: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT value_json FROM org_settings WHERE org_id = ? AND key = 'notification_channels' LIMIT 1`,
    args: [orgId],
  });
  const channels = new Set<string>([IN_APP]);
  const raw = res.rows[0]?.value_json;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const channel of parsed) {
          if (typeof channel === 'string' && VALID_CHANNELS.has(channel)) channels.add(channel);
        }
      }
    } catch {
      // Malformed settings: fall back to IN_APP only.
    }
  }
  return [...channels];
}

const RECIPIENT_COLUMN: Record<RecipientType, string> = {
  user: 'recipient_user_id',
  contractor: 'recipient_contractor_id',
  technician: 'recipient_technician_id',
};

/** Insert one QUEUED notification per resolved channel. */
export async function enqueue(
  db: SqlExecutor,
  orgId: string,
  params: EnqueueParams,
): Promise<void> {
  const channels = await resolveChannels(db, orgId);
  const column = RECIPIENT_COLUMN[params.recipientType]; // fixed set, safe to interpolate
  for (const channel of channels) {
    await db.execute({
      sql: `INSERT INTO notifications
              (org_id, channel, ${column}, template_key, subject, body, entity_type, entity_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')`,
      args: [
        orgId,
        channel,
        params.recipientId,
        params.templateKey,
        params.subject,
        params.body,
        params.entityType,
        params.entityId,
      ],
    });
  }
}

/**
 * Minimal in-app unread count for the current user, in any capacity: addressed
 * directly, or to a contractor or technician whose portal account they are.
 */
export async function getUnreadCount(
  db: SqlExecutor,
  orgId: string,
  userId: string,
): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications
           WHERE org_id = ? AND channel = 'IN_APP' AND status = 'QUEUED'
             AND (recipient_user_id = ?
                  OR recipient_contractor_id IN
                       (SELECT id FROM contractors WHERE org_id = ? AND portal_user_id = ?)
                  OR recipient_technician_id IN
                       (SELECT id FROM technicians WHERE org_id = ? AND portal_user_id = ?))`,
    args: [orgId, userId, orgId, userId, orgId, userId],
  });
  return Number(res.rows[0]?.n ?? 0);
}
