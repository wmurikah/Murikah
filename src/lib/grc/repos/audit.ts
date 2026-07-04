/**
 * Append-only audit trail. Every organisation switch (and, in later prompts,
 * every status change and privileged action) writes a row to `audit_log`, scoped
 * to the acting organisation and stamped with the actor and time.
 *
 * The column set follows the hassaudit conventions documented in
 * grc/docs/schema-assumptions.md and is the single place to reconcile if they
 * differ. Callers treat a failed audit write as non-fatal for a read-only action
 * like a switch (the switch is the user's own action), but the write is always
 * attempted.
 */
import type { Client } from '@libsql/client/web';

export interface AuditEntry {
  organizationId: string;
  userId: string;
  /** A short action code, e.g. ORG.switch. */
  action: string;
  /** Optional human or JSON detail. */
  details?: string | null;
}

export async function writeAuditLog(db: Client, entry: AuditEntry): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (organization_id, user_id, action, details, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      entry.organizationId,
      entry.userId,
      entry.action,
      entry.details ?? null,
      new Date().toISOString(),
    ],
  });
}
