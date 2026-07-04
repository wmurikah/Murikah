/**
 * The send-queue admin data (Sendqueue.html), for the SUPER_ADMIN monitor. It
 * reports the queue counts (pending, retrying after failure, sent, dead-letter),
 * lists queue rows and the dead-letter, and retries a row by returning it to
 * PENDING with a clean slate. Scoped by organization_id. The page and the retry
 * endpoint gate strictly on SUPER_ADMIN. Column names follow
 * grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';

export interface QueueCounts {
  pending: number;
  failed: number;
  sent: number;
  deadLetter: number;
}

export async function getQueueCounts(db: Client, organizationId: string): Promise<QueueCounts> {
  const res = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN status = 'PENDING' AND attempts = 0 THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'PENDING' AND attempts > 0 THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status = 'DEAD_LETTER' THEN 1 ELSE 0 END) AS dead_letter
          FROM notification_queue WHERE organization_id = ?`,
    args: [organizationId],
  });
  const r = res.rows[0] ?? {};
  return {
    pending: Number(r.pending ?? 0),
    failed: Number(r.failed ?? 0),
    sent: Number(r.sent ?? 0),
    deadLetter: Number(r.dead_letter ?? 0),
  };
}

export interface QueueRow {
  id: string;
  batchType: string;
  priority: string;
  recipientEmail: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string | null;
  sentAt: string | null;
  isCc: boolean;
}

export async function listQueue(
  db: Client,
  organizationId: string,
  filters: { status?: string; limit?: number } = {},
): Promise<QueueRow[]> {
  const args: (string | number)[] = [organizationId];
  let where = 'organization_id = ?';
  if (filters.status) {
    where += ' AND status = ?';
    args.push(filters.status);
  }
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 300));
  const res = await db.execute({
    sql: `SELECT notification_id AS id, batch_type, priority, recipient_email, status,
                 attempts, max_attempts, error_message, created_at, sent_at, is_cc
            FROM notification_queue WHERE ${where}
        ORDER BY created_at DESC LIMIT ${limit}`,
    args,
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    batchType: String(r.batch_type ?? ''),
    priority: String(r.priority ?? 'normal'),
    recipientEmail: String(r.recipient_email ?? ''),
    status: String(r.status ?? ''),
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 5),
    error: r.error_message == null ? null : String(r.error_message),
    createdAt: r.created_at == null ? null : String(r.created_at),
    sentAt: r.sent_at == null ? null : String(r.sent_at),
    isCc: Number(r.is_cc ?? 0) === 1,
  }));
}

export interface DeadLetterRow {
  id: string;
  batchType: string;
  recipientEmail: string;
  subject: string | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
}

export async function listDeadLetter(
  db: Client,
  organizationId: string,
  limit = 50,
): Promise<DeadLetterRow[]> {
  try {
    const res = await db.execute({
      sql: `SELECT notification_id AS id, batch_type, recipient_email, rendered_subject,
                   error_message, attempts, created_at
              FROM notification_dead_letter WHERE organization_id = ?
          ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`,
      args: [organizationId],
    });
    return res.rows.map((r) => ({
      id: String(r.id),
      batchType: String(r.batch_type ?? ''),
      recipientEmail: String(r.recipient_email ?? ''),
      subject: r.rendered_subject == null ? null : String(r.rendered_subject),
      error: r.error_message == null ? null : String(r.error_message),
      attempts: Number(r.attempts ?? 0),
      createdAt: r.created_at == null ? null : String(r.created_at),
    }));
  } catch {
    return [];
  }
}

/** Return a failed or dead-lettered row to PENDING with a clean slate, so the next drain retries it. */
export async function retryRow(db: Client, organizationId: string, id: string): Promise<boolean> {
  const res = await db.execute({
    sql: `UPDATE notification_queue
             SET status = 'PENDING', attempts = 0, error_message = NULL, updated_at = NULL
           WHERE notification_id = ? AND organization_id = ? AND status IN ('PENDING', 'DEAD_LETTER')`,
    args: [id, organizationId],
  });
  return (res.rowsAffected ?? 0) > 0;
}
