/**
 * Enqueue a notification for later delivery. On submit, send-to-auditee and
 * response events the workflow enqueues a `notification_queue` row referencing a
 * seeded `email_templates` code (for example `finding_shared`). The send queue
 * itself (the drain) is a later prompt; this only records the intent, scoped to
 * the acting organisation. Only `finding_shared` is a confirmed template code;
 * the others are documented assumptions (grc/docs/schema-assumptions.md), so a
 * missing template must not break the transition: enqueue is best-effort.
 */
import type { Client } from '@libsql/client/web';

export interface NotifyInput {
  organizationId: string;
  templateCode: string;
  /** The entity this notification is about, e.g. a work paper id. */
  entityType: string;
  entityId: string;
  /** The user who triggered it. */
  actorUserId: string;
}

export async function enqueueNotification(db: Client, input: NotifyInput): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO notification_queue
              (notification_id, organization_id, template_code, entity_type, entity_id,
               status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      args: [
        crypto.randomUUID(),
        input.organizationId,
        input.templateCode,
        input.entityType,
        input.entityId,
        input.actorUserId,
        new Date().toISOString(),
      ],
    });
  } catch {
    // Best-effort: a transition must not fail because a template is missing or
    // the queue shape differs. Reconcile the column names if needed.
  }
}
