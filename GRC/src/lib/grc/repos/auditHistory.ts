import type { Client } from '@libsql/client/web';

export interface AuditHistoryRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actor: string;
  occurredAt: string;
  details: string | null;
}

export interface AuditAnchorSummary {
  logCount: number;
  hash: string;
  anchoredAt: string;
}

export interface AuditHistoryFilters {
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
}

export async function listAuditHistory(
  db: Client,
  organizationId: string,
  filters: AuditHistoryFilters,
  limit = 200,
): Promise<AuditHistoryRow[]> {
  const where = ['a.organization_id = ?'];
  const args: (string | number)[] = [organizationId];
  if (filters.action) {
    where.push('a.action LIKE ?');
    args.push(`%${filters.action}%`);
  }
  if (filters.entityType) {
    where.push('a.entity_type = ?');
    args.push(filters.entityType);
  }
  if (filters.from) {
    where.push('a.occurred_at >= ?');
    args.push(`${filters.from}T00:00:00.000Z`);
  }
  if (filters.to) {
    where.push('a.occurred_at <= ?');
    args.push(`${filters.to}T23:59:59.999Z`);
  }
  args.push(limit);
  const res = await db.execute({
    sql: `SELECT a.log_id, a.action, a.entity_type, a.entity_id, a.occurred_at,
                 a.new_data, COALESCE(u.full_name, a.actor_email, a.actor_user_id, 'System') AS actor
            FROM audit_log a
            LEFT JOIN users u ON u.user_id = a.actor_user_id
             AND u.organization_id = a.organization_id
           WHERE ${where.join(' AND ')}
        ORDER BY a.occurred_at DESC, a.log_id DESC
           LIMIT ?`,
    args,
  });
  return res.rows.map((r) => {
    let details: string | null = null;
    try {
      const parsed = JSON.parse(String(r.new_data ?? '{}')) as { details?: unknown };
      details = parsed.details == null ? null : String(parsed.details);
    } catch {
      details = r.new_data == null ? null : String(r.new_data);
    }
    return {
      id: String(r.log_id),
      action: String(r.action),
      entityType: r.entity_type == null ? null : String(r.entity_type),
      entityId: r.entity_id == null ? null : String(r.entity_id),
      actor: String(r.actor),
      occurredAt: String(r.occurred_at),
      details,
    };
  });
}

export async function latestAuditAnchor(db: Client): Promise<AuditAnchorSummary | null> {
  const res = await db.execute(
    `SELECT log_count, cumulative_hash, anchored_at
       FROM audit_log_anchors ORDER BY anchor_id DESC LIMIT 1`,
  );
  const row = res.rows[0];
  return row
    ? {
        logCount: Number(row.log_count ?? 0),
        hash: String(row.cumulative_hash),
        anchoredAt: String(row.anchored_at),
      }
    : null;
}
