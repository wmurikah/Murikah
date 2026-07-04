/**
 * Scheduled reminders, ported from the source. The stale reminder (daily) nudges
 * the auditor on a work paper still in Draft with an assigned auditor created
 * more than STALE_REMINDER_DAYS ago, copies the Head of Audit, and is
 * deduplicated to at most one per work paper and recipient every three days. The
 * overdue reminder (weekly) re-notifies the owners of an overdue action plan,
 * deduplicated to one per plan and owner every seven days. Both enqueue through
 * the shared queue and are scoped by organisation. Overdue reuses the reporting
 * model's settled-status set so every surface agrees.
 */
import type { Client } from '@libsql/client/web';
import type { Clock } from '@engr/time';
import { NOT_OVERDUE_STATUSES } from '@grc/reports/reportModel';
import { queueNotification, queueHoaCc } from './queue';
import { resolveActiveRecipient, resolveActiveRecipients } from './recipients';
import { entityLink } from './links';

const STALE_REMINDER_DAYS = 3;
const STALE_DEDUP_DAYS = 3;
const OVERDUE_DEDUP_DAYS = 7;

async function alreadyReminded(
  db: Client,
  organizationId: string,
  batchType: string,
  entityId: string,
  recipientUserId: string,
  withinDays: number,
  nowIso: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM notification_queue
           WHERE organization_id = ? AND batch_type = ? AND related_entity_id = ?
             AND recipient_user_id = ?
             AND datetime(created_at, '+' || ? || ' days') > ?
           LIMIT 1`,
    args: [organizationId, batchType, entityId, recipientUserId, withinDays, nowIso],
  });
  return res.rows.length > 0;
}

/** Daily: remind auditors of stale draft work papers, copying the Head of Audit. */
export async function runStaleReminders(db: Client, clock: Clock): Promise<{ queued: number }> {
  const nowIso = clock.now().toISOString();
  const res = await db.execute({
    sql: `SELECT work_paper_id AS id, organization_id, reference, observation_title AS title,
                 assigned_auditor
            FROM work_papers
           WHERE status = 'DRAFT' AND assigned_auditor IS NOT NULL AND created_at IS NOT NULL
             AND datetime(created_at, '+' || ? || ' days') <= ?
           LIMIT 500`,
    args: [STALE_REMINDER_DAYS, nowIso],
  });

  let queued = 0;
  for (const row of res.rows) {
    const id = String(row.id);
    const organizationId = String(row.organization_id);
    const auditor = String(row.assigned_auditor);
    if (
      await alreadyReminded(
        db,
        organizationId,
        'STALE_REMINDER',
        id,
        auditor,
        STALE_DEDUP_DAYS,
        nowIso,
      )
    ) {
      continue;
    }
    const recipient = await resolveActiveRecipient(db, organizationId, auditor);
    if (!recipient) continue;
    const data = {
      reference: String(row.reference ?? id),
      title: String(row.title ?? ''),
      link: entityLink('work_paper', id),
    };
    await queueNotification(db, organizationId, {
      type: 'STALE_REMINDER',
      recipient,
      data,
      relatedEntityType: 'work_paper',
      relatedEntityId: id,
      actorUserId: null,
    });
    await queueHoaCc(db, organizationId, {
      type: 'STALE_REMINDER',
      data,
      relatedEntityType: 'work_paper',
      relatedEntityId: id,
      actorUserId: auditor,
    });
    queued += 1;
  }
  return { queued };
}

/** Weekly: re-notify owners of overdue action plans. */
export async function runOverdueReminders(db: Client, clock: Clock): Promise<{ queued: number }> {
  const nowIso = clock.now().toISOString();
  const placeholders = NOT_OVERDUE_STATUSES.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT action_plan_id AS id, organization_id, action_number AS reference,
                 action_description AS title, owner_ids, due_date
            FROM action_plans
           WHERE due_date IS NOT NULL AND date(due_date) < date('now')
             AND status NOT IN (${placeholders})
           LIMIT 1000`,
    args: [...NOT_OVERDUE_STATUSES],
  });

  let queued = 0;
  for (const row of res.rows) {
    const id = String(row.id);
    const organizationId = String(row.organization_id);
    const ownerIds =
      row.owner_ids == null
        ? []
        : String(row.owner_ids)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    const owners = await resolveActiveRecipients(db, organizationId, ownerIds);
    for (const recipient of owners) {
      if (
        await alreadyReminded(
          db,
          organizationId,
          'OVERDUE_REMINDER',
          id,
          recipient.userId,
          OVERDUE_DEDUP_DAYS,
          nowIso,
        )
      ) {
        continue;
      }
      await queueNotification(db, organizationId, {
        type: 'OVERDUE_REMINDER',
        recipient,
        data: {
          reference: String(row.reference ?? id),
          title: String(row.title ?? ''),
          dueDate: row.due_date == null ? '' : String(row.due_date),
          link: entityLink('action_plan', id),
        },
        relatedEntityType: 'action_plan',
        relatedEntityId: id,
        actorUserId: null,
      });
      queued += 1;
    }
  }
  return { queued };
}
