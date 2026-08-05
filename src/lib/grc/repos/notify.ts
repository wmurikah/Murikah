/**
 * The shared enqueue path every module already calls. It keeps the small
 * NotifyInput contract (template code plus the entity and the actor) and now
 * drives the full notification service (05_NotificationService.gs): it maps the
 * code to a notification type, resolves the interested recipients (skipping the
 * actor and inactive users), builds the payload from the entity, queues a
 * notification for each through the universal queue (which renders, writes the
 * queue row and mirrors the in-app row), and copies the Head of Audit on the key
 * events. Everything is scoped to the acting organisation and best-effort, so a
 * transition never fails because delivery is unconfigured.
 */
import type { Client } from '@libsql/client/web';
import { entityOf, type NotificationType } from '@grc/notify/types';
import { queueNotification, queueHoaCc } from '@grc/notify/queue';
import type { Payload } from '@grc/notify/render';
import {
  resolveActiveRecipients,
  actionPlanOwnerIds,
  workPaperPartyIds,
} from '@grc/notify/recipients';
import { entityLink } from '@grc/notify/links';

export interface NotifyInput {
  organizationId: string;
  templateCode: string;
  /** The entity this notification is about, e.g. a work paper id. */
  entityType: string;
  entityId: string;
  /** The user who triggered it. */
  actorUserId: string;
}

// The module template codes map to the source NOTIFICATION_TYPES.
const TEMPLATE_TO_TYPE: Record<string, NotificationType> = {
  action_assigned: 'AP_ASSIGNED',
  action_delegated: 'AP_DELEGATED',
  action_implemented: 'AP_IMPLEMENTED',
  action_verified: 'AP_VERIFIED',
  action_returned: 'AP_HOA_REVIEWED',
  action_rejected: 'AP_HOA_REVIEWED',
  action_closed: 'AP_HOA_REVIEWED',
  finding_shared: 'WP_SENT_TO_AUDITEE',
  finding_submitted: 'WP_SUBMITTED',
  response_received: 'RESPONSE_SUBMITTED',
};

async function loadEntityPayload(
  db: Client,
  organizationId: string,
  entity: 'work_paper' | 'action_plan',
  entityId: string,
): Promise<Payload> {
  const base: Payload = { link: entityLink(entity, entityId) };
  try {
    if (entity === 'action_plan') {
      const res = await db.execute({
        sql: `SELECT COALESCE(action_ref, action_number) AS action_number, action_description, status, due_date, owner_names
                FROM action_plans WHERE action_plan_id = ? AND organization_id = ? LIMIT 1`,
        args: [entityId, organizationId],
      });
      const r = res.rows[0];
      if (r) {
        base.reference = String(r.action_number ?? entityId);
        base.title = String(r.action_description ?? '');
        base.status = String(r.status ?? '');
        if (r.due_date != null) base.dueDate = String(r.due_date);
        if (r.owner_names != null) base.ownerNames = String(r.owner_names);
      }
    } else {
      const res = await db.execute({
        sql: `SELECT work_paper_ref AS reference, observation_title, status, risk_rating
                FROM work_papers WHERE work_paper_id = ? AND organization_id = ? LIMIT 1`,
        args: [entityId, organizationId],
      });
      const r = res.rows[0];
      if (r) {
        base.reference = String(r.reference ?? entityId);
        base.title = String(r.observation_title ?? '');
        base.status = String(r.status ?? '');
        if (r.risk_rating != null) base.riskRating = String(r.risk_rating);
      }
    }
  } catch {
    // best-effort: the payload still carries the deep link.
  }
  return base;
}

export async function enqueueNotification(db: Client, input: NotifyInput): Promise<void> {
  try {
    const type = TEMPLATE_TO_TYPE[input.templateCode];
    if (!type) return; // unknown code: nothing to send.
    const entity = entityOf(type);
    // Only entity-driven types route through here; the account-level types
    // (password reset) queue directly with an explicit recipient.
    if (entity !== 'work_paper' && entity !== 'action_plan') return;

    const userIds =
      entity === 'action_plan'
        ? await actionPlanOwnerIds(db, input.organizationId, input.entityId)
        : await workPaperPartyIds(db, input.organizationId, input.entityId);
    const recipients = (await resolveActiveRecipients(db, input.organizationId, userIds)).filter(
      (r) => r.userId !== input.actorUserId,
    );

    const data = await loadEntityPayload(db, input.organizationId, entity, input.entityId);
    if (input.actorUserId) data.actorName = data.actorName ?? '';

    for (const recipient of recipients) {
      await queueNotification(db, input.organizationId, {
        type,
        recipient,
        data,
        relatedEntityType: entity,
        relatedEntityId: input.entityId,
        actorUserId: input.actorUserId,
      });
    }
    await queueHoaCc(db, input.organizationId, {
      type,
      data,
      relatedEntityType: entity,
      relatedEntityId: input.entityId,
      actorUserId: input.actorUserId,
    });
  } catch {
    // Best-effort: enqueue must never break the triggering transition.
  }
}
