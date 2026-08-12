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
  /**
   * The comment the transition carried, when it carried one: the reviewer's
   * reason for sending a finding back, which the email must repeat rather than
   * merely announce (Build Prompt 62).
   */
  comment?: string | null;
}

/**
 * Who a work-paper event is for: the party who must act next, not everybody
 * attached to the finding (Build Prompt 62).
 *
 * A return for revision is the auditor's to answer, and telling the responsibles
 * instead is how a loop stalls with everyone assuming somebody else was told. A
 * share with the auditee is the responsibles' and the CC list's. Everything else
 * keeps the party set it always had: the assigned auditor and the responsibles.
 */
async function workPaperRecipientIds(
  db: Client,
  organizationId: string,
  workPaperId: string,
  type: NotificationType,
): Promise<string[]> {
  if (type === 'WP_REVISION_REQUIRED' || type === 'WP_APPROVED') {
    const auditor = await assignedAuditorId(db, organizationId, workPaperId);
    return auditor ? [auditor] : [];
  }
  return workPaperPartyIds(db, organizationId, workPaperId);
}

/** The auditor answerable for a finding, or null when it has none. */
async function assignedAuditorId(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT assigned_auditor_id AS auditor FROM work_papers
           WHERE work_paper_id = ? AND organization_id = ? LIMIT 1`,
    args: [workPaperId, organizationId],
  });
  const auditor = res.rows[0]?.auditor;
  return auditor == null || String(auditor).trim() === '' ? null : String(auditor).trim();
}

// The module template codes map to the source NOTIFICATION_TYPES.
const TEMPLATE_TO_TYPE: Record<string, NotificationType> = {
  // Every round of the review loop tells the person who now has to act
  // (Build Prompt 62). Returning a finding used to tell nobody: the reviewer
  // wrote what was wrong with it and the auditor found out by opening the list.
  finding_revision_required: 'WP_REVISION_REQUIRED',
  finding_approved: 'WP_APPROVED',
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
      // The audit area comes along for the digest's detail column (Build Prompt
      // 53): "Treasury, High" tells a reviewer what they are being asked to
      // look at; a reference alone does not. Left-joined, so a finding with no
      // area still notifies.
      const res = await db.execute({
        sql: `SELECT wp.work_paper_ref AS reference, wp.observation_title, wp.status,
                     wp.risk_rating, aa.area_name AS audit_area
                FROM work_papers wp
                LEFT JOIN audit_areas aa ON aa.audit_area_id = wp.audit_area_id
               WHERE wp.work_paper_id = ? AND wp.organization_id = ? LIMIT 1`,
        args: [entityId, organizationId],
      });
      const r = res.rows[0];
      if (r) {
        base.reference = String(r.reference ?? entityId);
        base.title = String(r.observation_title ?? '');
        base.status = String(r.status ?? '');
        if (r.risk_rating != null) base.riskRating = String(r.risk_rating);
        if (r.audit_area != null) base.auditArea = String(r.audit_area);
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
        : await workPaperRecipientIds(db, input.organizationId, input.entityId, type);
    const recipients = (await resolveActiveRecipients(db, input.organizationId, userIds)).filter(
      (r) => r.userId !== input.actorUserId,
    );

    const data = await loadEntityPayload(db, input.organizationId, entity, input.entityId);
    if (input.actorUserId) data.actorName = data.actorName ?? '';
    // The reviewer's words travel with the decision. A return that says only
    // "revision required" sends the auditor back to the screen to find out what
    // for, which is the email failing at the one thing it is for.
    if (input.comment) data.comment = input.comment;

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
