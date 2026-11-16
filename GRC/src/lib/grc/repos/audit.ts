/**
 * Append-only audit trail. Every privileged write (a Setup change, a status
 * transition, an organisation switch) records a row in `audit_log`, stamped with
 * the actor and the time.
 *
 * Every row has an application-generated id and a first-class organisation id.
 * The latter makes tenant scoping and time-range searches enforceable without
 * parsing JSON. `buildAuditStatement` returns the same insert as an InStatement
 * so a caller can include it in an atomic batch alongside the change it records.
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
            (${A.log_id}, ${A.organization_id}, ${A.action}, ${A.entity_type}, ${A.entity_id},
             ${A.new_data}, ${A.actor_user_id}, ${A.occurred_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      entry.organizationId,
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
