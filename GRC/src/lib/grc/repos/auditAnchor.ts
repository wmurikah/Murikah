/** Tamper-evident hash chaining for the append-only audit log. */
import type { Client } from '@libsql/client/web';

const encoder = new TextEncoder();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Anchor {
  lastLogId: string;
  logCount: number;
  hash: string;
}

async function latestAnchor(db: Client): Promise<Anchor | null> {
  const res = await db.execute(
    `SELECT last_log_id, log_count, cumulative_hash
       FROM audit_log_anchors ORDER BY anchor_id DESC LIMIT 1`,
  );
  const row = res.rows[0];
  return row
    ? {
        lastLogId: String(row.last_log_id),
        logCount: Number(row.log_count ?? 0),
        hash: String(row.cumulative_hash),
      }
    : null;
}

/** Add one anchor for the next batch of log entries. Returns rows anchored. */
export async function anchorAuditLog(db: Client, limit = 1000): Promise<number> {
  const previous = await latestAnchor(db);
  let cursorAt: string | null = null;
  if (previous) {
    const cursor = await db.execute({
      sql: `SELECT occurred_at FROM audit_log WHERE log_id = ? LIMIT 1`,
      args: [previous.lastLogId],
    });
    cursorAt = cursor.rows[0]?.occurred_at == null ? null : String(cursor.rows[0].occurred_at);
  }

  const args: (string | number)[] = [];
  let after = '';
  if (previous && cursorAt) {
    after = `WHERE (occurred_at > ? OR (occurred_at = ? AND log_id > ?))`;
    args.push(cursorAt, cursorAt, previous.lastLogId);
  }
  args.push(limit);
  const rows = await db.execute({
    sql: `SELECT log_id, organization_id, action, entity_type, entity_id, old_data,
                 new_data, actor_user_id, actor_email, actor_ip, occurred_at
            FROM audit_log ${after}
        ORDER BY occurred_at, log_id LIMIT ?`,
    args,
  });
  if (rows.rows.length === 0) return 0;

  let hash = previous?.hash ?? '0'.repeat(64);
  for (const row of rows.rows) {
    hash = await sha256(
      `${hash}\n${JSON.stringify([
        row.log_id,
        row.organization_id,
        row.action,
        row.entity_type,
        row.entity_id,
        row.old_data,
        row.new_data,
        row.actor_user_id,
        row.actor_email,
        row.actor_ip,
        row.occurred_at,
      ])}`,
    );
  }

  const last = rows.rows.at(-1)!;
  await db.execute({
    sql: `INSERT INTO audit_log_anchors
            (last_log_id, log_count, cumulative_hash, anchored_at, external_proof)
          VALUES (?, ?, ?, ?, NULL)`,
    args: [
      String(last.log_id),
      (previous?.logCount ?? 0) + rows.rows.length,
      hash,
      new Date().toISOString(),
    ],
  });
  return rows.rows.length;
}
