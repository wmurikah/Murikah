/**
 * Append-only audit trail. Every privileged write (a Setup change, a status
 * transition, an organisation switch) records a row in `audit_log`, stamped with
 * the actor and the time.
 *
 * Column names come from the typed schema layer (@grc/schema/columns). The live
 * `audit_log` has no organization_id of its own: the acting organisation and any
 * human detail are preserved in `new_data` so nothing is lost, and `log_id` is
 * assigned by the database. `buildAuditStatement` returns the same insert as an
 * InStatement so a caller can include it in an atomic batch alongside the change
 * it records.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const A = cols(C.audit_log);

export interface AuditEntry {
  organizationId: string;
  userId: string;
  /** A short action code, e.g. AFFILIATE.create or ORG.switch. */
  action: string;
  /** The kind of record acted on, e.g. affiliate, user, work_paper. */
  entityType?: string | null;
  /** The natural id of the record acted on. */
  entityId?: string | null;
  /** Optional human or JSON detail, kept alongside the organisation in new_data. */
  details?: string | null;
}

function newData(entry: AuditEntry): string {
  return JSON.stringify({ organizationId: entry.organizationId, details: entry.details ?? null });
}

/** The audit insert as a batchable statement, for callers writing atomically. */
export function buildAuditStatement(entry: AuditEntry): InStatement {
  return {
    sql: `INSERT INTO audit_log
            (${A.action}, ${A.entity_type}, ${A.entity_id}, ${A.new_data}, ${A.actor_user_id}, ${A.occurred_at})
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      newData(entry),
      entry.userId,
      new Date().toISOString(),
    ],
  };
}

export async function writeAuditLog(db: Client, entry: AuditEntry): Promise<void> {
  await db.execute(buildAuditStatement(entry));
}
