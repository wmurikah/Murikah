/**
 * The send loop, the port of the source send queue on the Engineering Rhythm
 * scan-and-drain pattern with an injectable clock and a production gate. It reads
 * due PENDING rows (urgent first, oldest first, across organisations within a
 * bounded batch), sends urgent items promptly and batches normal items per
 * recipient into one digest email, all through Microsoft Graph.
 *
 * On send the row goes SENT with sent_at; on failure attempts is incremented and
 * error_message recorded, with an exponential backoff before the next try; when
 * attempts reach max_attempts the row is moved to notification_dead_letter. When
 * Graph is not configured (or outside production) nothing is sent and the rows
 * are left PENDING, so a preview or local run never contacts a provider.
 */
import type { Client, InArgs } from '@libsql/client/web';
import type { Clock } from '@engr/time';
import { canSend, type GrcDeliveryEnv } from './env';
import { sendViaGraph } from './graph';
import { buildDigest, type DigestItem } from './render';

export interface DispatchOptions {
  limit: number;
}
export interface DispatchSummary {
  scanned: number;
  sent: number;
  failed: number;
  deadLettered: number;
  heldDryRun: number;
}

interface QueueRow {
  id: string;
  organizationId: string;
  batchType: string;
  priority: string;
  recipientEmail: string;
  subject: string;
  body: string;
  payload: string;
  attempts: number;
  maxAttempts: number;
}

// The backoff before the next attempt grows with attempts (0, 5, 20, 45, 80
// minutes), applied in fetchDue against updated_at.
async function fetchDue(db: Client, nowIso: string, limit: number): Promise<QueueRow[]> {
  const res = await db.execute({
    sql: `SELECT notification_id AS id, organization_id, batch_type, priority,
                 recipient_email, rendered_subject, rendered_body, payload,
                 attempts, max_attempts
            FROM notification_queue
           WHERE status = 'PENDING' AND channel = 'email' AND recipient_email IS NOT NULL
             AND (updated_at IS NULL
                  OR datetime(updated_at, '+' || (attempts * attempts * 5) || ' minutes') <= ?)
        ORDER BY (priority = 'urgent') DESC, created_at ASC
           LIMIT ?`,
    args: [nowIso, Math.max(1, Math.min(limit, 500))],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    organizationId: String(r.organization_id),
    batchType: String(r.batch_type ?? ''),
    priority: String(r.priority ?? 'normal'),
    recipientEmail: String(r.recipient_email),
    subject: String(r.rendered_subject ?? ''),
    body: String(r.rendered_body ?? ''),
    payload: String(r.payload ?? '{}'),
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 5),
  }));
}

async function markSent(db: Client, ids: string[], nowIso: string): Promise<void> {
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(', ');
  await db.execute({
    sql: `UPDATE notification_queue SET status = 'SENT', sent_at = ?, updated_at = ?
           WHERE notification_id IN (${ph})`,
    args: [nowIso, nowIso, ...ids] as InArgs,
  });
}

async function recordFailure(
  db: Client,
  row: QueueRow,
  error: string,
  nowIso: string,
): Promise<boolean> {
  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= row.maxAttempts) {
    await db.batch(
      [
        {
          sql: `INSERT INTO notification_dead_letter
                  (notification_id, organization_id, batch_type, recipient_email,
                   rendered_subject, error_message, attempts, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            row.id,
            row.organizationId,
            row.batchType,
            row.recipientEmail,
            row.subject,
            error,
            nextAttempts,
            nowIso,
          ],
        },
        {
          sql: `UPDATE notification_queue SET status = 'DEAD_LETTER', attempts = ?,
                   error_message = ?, updated_at = ? WHERE notification_id = ?`,
          args: [nextAttempts, error, nowIso, row.id],
        },
      ],
      'write',
    );
    return true;
  }
  await db.execute({
    sql: `UPDATE notification_queue SET attempts = ?, error_message = ?, updated_at = ?
           WHERE notification_id = ?`,
    args: [nextAttempts, error, nowIso, row.id],
  });
  return false;
}

function digestItem(row: QueueRow): DigestItem {
  let link: string | undefined;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof payload.link === 'string') link = payload.link;
  } catch {
    link = undefined;
  }
  return { subject: row.subject, intro: '', link };
}

/** Drain the queue: send urgent items individually and normal items as per-recipient digests. */
export async function runGrcDispatch(
  db: Client,
  delivery: GrcDeliveryEnv,
  clock: Clock,
  opts: DispatchOptions,
): Promise<DispatchSummary> {
  const now = clock.now();
  const nowIso = now.toISOString();
  const rows = await fetchDue(db, nowIso, opts.limit);
  const summary: DispatchSummary = {
    scanned: rows.length,
    sent: 0,
    failed: 0,
    deadLettered: 0,
    heldDryRun: 0,
  };

  // Outside production, or without Graph credentials, drain nothing: leave PENDING.
  if (!canSend(delivery) || !delivery.outlook) {
    summary.heldDryRun = rows.length;
    return summary;
  }
  const cfg = delivery.outlook;

  const urgent = rows.filter((r) => r.priority === 'urgent');
  const normal = rows.filter((r) => r.priority !== 'urgent');

  // Urgent: one email per row.
  for (const row of urgent) {
    const res = await sendViaGraph(
      cfg,
      { to: row.recipientEmail, subject: row.subject, html: row.body },
      now.getTime(),
    );
    if (res.ok) {
      await markSent(db, [row.id], nowIso);
      summary.sent += 1;
    } else {
      const dead = await recordFailure(db, row, res.error ?? 'send failed', nowIso);
      summary.failed += 1;
      if (dead) summary.deadLettered += 1;
    }
  }

  // Normal: batch per recipient into one digest.
  const byRecipient = new Map<string, QueueRow[]>();
  for (const row of normal) {
    const list = byRecipient.get(row.recipientEmail) ?? [];
    list.push(row);
    byRecipient.set(row.recipientEmail, list);
  }
  for (const [email, group] of byRecipient) {
    const digest = buildDigest(group.map(digestItem));
    const res = await sendViaGraph(
      cfg,
      { to: email, subject: digest.subject, html: digest.body },
      now.getTime(),
    );
    if (res.ok) {
      await markSent(
        db,
        group.map((g) => g.id),
        nowIso,
      );
      summary.sent += group.length;
    } else {
      for (const row of group) {
        const dead = await recordFailure(db, row, res.error ?? 'send failed', nowIso);
        summary.failed += 1;
        if (dead) summary.deadLettered += 1;
      }
    }
  }

  return summary;
}
