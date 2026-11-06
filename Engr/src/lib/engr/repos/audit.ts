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
       LEFT JOIN users u ON u.id = a.actor_user_id AND u.org_id = a.org_id
           WHERE a.org_id = ?
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
