/**
 * In-app notifications for the bell. Every notification queued through the shared
 * path mirrors an in_app_notifications row; this reads the signed-in user's own,
 * counts the unread (read_at is null), and marks them read.
 *
 * Column names come from the typed schema layer: the key is `in_app_id` and the
 * link column is `deep_link`. The live table carries no organization_id; rows are
 * addressed to a user_id, and users are organisation-scoped by the session, so
 * scoping by the verified user preserves tenancy. Read failures are logged and
 * degrade to an empty bell; they are never silently swallowed.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const N = cols(C.in_app_notifications);
const TAG = '[grc.notify.inApp]';

export interface InAppItem {
  id: string;
  title: string;
  body: string | null;
  severity: string;
  link: string | null;
  createdAt: string | null;
  read: boolean;
}

export async function unreadCount(db: Client, userId: string): Promise<number> {
  try {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM in_app_notifications
             WHERE ${N.user_id} = ? AND ${N.read_at} IS NULL`,
      args: [userId],
    });
    return Number(res.rows[0]?.n ?? 0);
  } catch (err) {
    console.error(`${TAG} unreadCount failed`, err);
    return 0;
  }
}

export async function listInApp(db: Client, userId: string, limit = 20): Promise<InAppItem[]> {
  try {
    const res = await db.execute({
      sql: `SELECT ${N.in_app_id} AS id, ${N.title} AS title, ${N.body} AS body,
                   ${N.severity} AS severity, ${N.deep_link} AS link,
                   ${N.read_at} AS read_at, ${N.created_at} AS created_at
              FROM in_app_notifications
             WHERE ${N.user_id} = ?
          ORDER BY ${N.created_at} DESC LIMIT ?`,
      args: [userId, Math.max(1, Math.min(limit, 100))],
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
  } catch (err) {
    console.error(`${TAG} listInApp failed`, err);
    return [];
  }
}

export async function markRead(db: Client, userId: string, id: string): Promise<boolean> {
  const res = await db.execute({
    sql: `UPDATE in_app_notifications SET ${N.read_at} = ?
           WHERE ${N.in_app_id} = ? AND ${N.user_id} = ? AND ${N.read_at} IS NULL`,
    args: [new Date().toISOString(), id, userId],
  });
  return (res.rowsAffected ?? 0) > 0;
}

export async function markAllRead(db: Client, userId: string): Promise<number> {
  const res = await db.execute({
    sql: `UPDATE in_app_notifications SET ${N.read_at} = ?
           WHERE ${N.user_id} = ? AND ${N.read_at} IS NULL`,
    args: [new Date().toISOString(), userId],
  });
  return res.rowsAffected ?? 0;
}
