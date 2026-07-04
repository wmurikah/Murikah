/**
 * In-app notifications for the bell. Every notification queued through the shared
 * path mirrors an in_app_notifications row; this reads the signed-in user's own,
 * counts the unread (read_at is null), and marks them read. Scoped by
 * organization_id and user_id, so the bell never shows another user's or another
 * organisation's items. Column names follow grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';

export interface InAppItem {
  id: string;
  title: string;
  body: string | null;
  severity: string;
  link: string | null;
  createdAt: string | null;
  read: boolean;
}

export async function unreadCount(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<number> {
  try {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM in_app_notifications
             WHERE organization_id = ? AND user_id = ? AND read_at IS NULL`,
      args: [organizationId, userId],
    });
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function listInApp(
  db: Client,
  organizationId: string,
  userId: string,
  limit = 20,
): Promise<InAppItem[]> {
  try {
    const res = await db.execute({
      sql: `SELECT notification_id AS id, title, body, severity, link, read_at, created_at
              FROM in_app_notifications
             WHERE organization_id = ? AND user_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      args: [organizationId, userId, Math.max(1, Math.min(limit, 100))],
    });
    return res.rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      body: r.body == null ? null : String(r.body),
      severity: String(r.severity ?? 'info'),
      link: r.link == null ? null : String(r.link),
      createdAt: r.created_at == null ? null : String(r.created_at),
      read: r.read_at != null,
    }));
  } catch {
    return [];
  }
}

export async function markRead(
  db: Client,
  organizationId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `UPDATE in_app_notifications SET read_at = ?
           WHERE notification_id = ? AND organization_id = ? AND user_id = ? AND read_at IS NULL`,
    args: [new Date().toISOString(), id, organizationId, userId],
  });
  return (res.rowsAffected ?? 0) > 0;
}

export async function markAllRead(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<number> {
  const res = await db.execute({
    sql: `UPDATE in_app_notifications SET read_at = ?
           WHERE organization_id = ? AND user_id = ? AND read_at IS NULL`,
    args: [new Date().toISOString(), organizationId, userId],
  });
  return res.rowsAffected ?? 0;
}
