/**
 * The send loop, the port of the source send queue on the Engineering Rhythm
 * scan-and-drain pattern with an injectable clock and a production gate. It reads
 * due PENDING rows (urgent first, oldest first, across organisations within a
 * bounded batch), sends urgent items promptly and batches normal items per
 * recipient into one digest email, all through Microsoft Graph.
 *
 * On send the row goes SENT with sent_at; on failure attempts is incremented and
 * error_message recorded, with an exponential backoff before the next try; when
 * attempts reach max_attempts the row is recorded in notification_dead_letter.
 * When Graph is not configured (or outside production) nothing is sent and the
 * rows are left PENDING, so a preview or local run never contacts a provider.
 *
 * Column names come from the typed schema layer. The queue has no updated_at:
 * the backoff is held in `scheduled_for` (the not-before time the next attempt
 * may run), and the live `notification_dead_letter` stores the frozen queue row
 * as `original_queue_data` JSON with `last_error`/`failed_at`.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
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

const Q = cols(C.notification_queue);
const DL = cols(C.notification_dead_letter);

// The backoff before the next attempt grows with attempts (0, 5, 20, 45, 80
// minutes): recordFailure writes the not-before time into scheduled_for, and
// fetchDue only picks rows whose scheduled_for has passed.
async function fetchDue(db: Client, nowIso: string, limit: number): Promise<QueueRow[]> {
  const res = await db.execute({
    sql: `SELECT ${Q.notification_id} AS id, ${Q.organization_id} AS organization_id,
                 ${Q.batch_type} AS batch_type, ${Q.priority} AS priority,
                 ${Q.recipient_email} AS recipient_email, ${Q.rendered_subject} AS rendered_subject,
                 ${Q.rendered_body} AS rendered_body, ${Q.payload} AS payload,
                 ${Q.attempts} AS attempts, ${Q.max_attempts} AS max_attempts
            FROM notification_queue
           WHERE ${Q.status} = 'PENDING' AND ${Q.channel} = 'email'
             AND ${Q.recipient_email} IS NOT NULL
             AND (${Q.scheduled_for} IS NULL OR ${Q.scheduled_for} <= ?)
        ORDER BY (${Q.priority} = 'urgent') DESC, ${Q.created_at} ASC
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
    sql: `UPDATE notification_queue SET ${Q.status} = 'SENT', ${Q.sent_at} = ?
           WHERE ${Q.notification_id} IN (${ph})`,
    args: [nowIso, ...ids] as InArgs,
  });
}

/** The not-before time for the next attempt: now plus attempts^2 * 5 minutes. */
function backoffIso(nowIso: string, attempts: number): string {
  return new Date(new Date(nowIso).getTime() + attempts * attempts * 5 * 60_000).toISOString();
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
                  (${DL.notification_id}, ${DL.original_queue_data}, ${DL.last_error}, ${DL.failed_at})
                VALUES (?, ?, ?, ?)`,
          args: [
            row.id,
            JSON.stringify({
              organizationId: row.organizationId,
              batchType: row.batchType,
              recipientEmail: row.recipientEmail,
              subject: row.subject,
              attempts: nextAttempts,
            }),
            error,
            nowIso,
          ],
        },
        {
          sql: `UPDATE notification_queue SET ${Q.status} = 'DEAD_LETTER', ${Q.attempts} = ?,
                   ${Q.error_message} = ? WHERE ${Q.notification_id} = ?`,
          args: [nextAttempts, error, row.id],
        },
      ],
      'write',
    );
    return true;
  }
  await db.execute({
    sql: `UPDATE notification_queue SET ${Q.attempts} = ?, ${Q.error_message} = ?,
                 ${Q.scheduled_for} = ? WHERE ${Q.notification_id} = ?`,
    args: [nextAttempts, error, backoffIso(nowIso, nextAttempts), row.id],
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
