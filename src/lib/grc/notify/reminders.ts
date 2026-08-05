/**
 * Scheduled reminders, ported from the source and paced by each organisation's
 * own `config` rows. The stale reminder (daily) nudges the auditor on a work
 * paper still in Draft with an assigned auditor older than that organisation's
 * STALE_REMINDER_DAYS, copies the Head of Audit, and is deduplicated to at most
 * one per work paper and recipient every three days. The overdue reminder
 * (weekly) re-notifies the owners of an overdue action plan on the weekday the
 * organisation configured (OVERDUE_REMINDER_DAY, Monday by default),
 * deduplicated to one per plan and owner every seven days. The due-soon
 * reminder (daily) warns owners of a plan approaching its deadline, so the
 * overdue mail is never the first they hear of it. All three enqueue through
 * the shared queue and are scoped by organisation. Overdue and due-soon reuse
 * the reporting model's settled-status set so every surface agrees.
 */
import type { Client } from '@libsql/client/web';
import type { Clock } from '@engr/time';
import { NOT_OVERDUE_STATUSES } from '@grc/reports/reportModel';
import { queueNotification, queueHoaCc } from './queue';
import { resolveActiveRecipient, resolveActiveRecipients } from './recipients';
import { entityLink } from './links';
import { DEFAULT_STALE_REMINDER_DAYS, DUE_SOON_DAYS, overdueRunsToday } from './reminderRules';

const STALE_DEDUP_DAYS = 3;
const OVERDUE_DEDUP_DAYS = 7;
const DUE_SOON_DEDUP_DAYS = 3;

/** One organisation's value for a config key, across every organisation at once. */
async function configByOrg(db: Client, key: string): Promise<Map<string, string>> {
  const res = await db.execute({
    sql: `SELECT organization_id, config_value FROM config WHERE config_key = ?`,
    args: [key],
  });
  const map = new Map<string, string>();
  for (const r of res.rows) {
    if (r.organization_id != null && r.config_value != null) {
      map.set(String(r.organization_id), String(r.config_value));
    }
  }
  return map;
}

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

/**
 * Daily: remind auditors of stale draft work papers, copying the Head of Audit.
 * The staleness window is each organisation's own STALE_REMINDER_DAYS config
 * (the Settings screen edits it), guarded in SQL so a blank or nonsense value
 * falls back to the default rather than silencing or flooding the reminder.
 */
export async function runStaleReminders(db: Client, clock: Clock): Promise<{ queued: number }> {
  const nowIso = clock.now().toISOString();
  const res = await db.execute({
    sql: `SELECT wp.work_paper_id AS id, wp.organization_id AS organization_id,
                 wp.work_paper_ref AS reference, wp.observation_title AS title,
                 wp.assigned_auditor_id AS assigned_auditor
            FROM work_papers wp
            LEFT JOIN config c ON c.organization_id = wp.organization_id
                 AND c.config_key = 'STALE_REMINDER_DAYS'
           WHERE wp.status = 'Draft' AND wp.assigned_auditor_id IS NOT NULL
             AND wp.created_at IS NOT NULL
             AND datetime(wp.created_at, '+' ||
                   (CASE WHEN CAST(c.config_value AS INTEGER) BETWEEN 1 AND 365
                         THEN CAST(c.config_value AS INTEGER) ELSE ? END) || ' days') <= ?
           LIMIT 500`,
    args: [DEFAULT_STALE_REMINDER_DAYS, nowIso],
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

/**
 * Weekly: re-notify owners of overdue action plans, on the weekday each
 * organisation configured (OVERDUE_REMINDER_DAY; Monday when unset). The caller
 * runs this daily and each organisation's plans are simply skipped on the six
 * days that are not theirs, so one cron serves every tenant's schedule.
 */
export async function runOverdueReminders(db: Client, clock: Clock): Promise<{ queued: number }> {
  const nowIso = clock.now().toISOString();
  const utcDay = clock.now().getUTCDay();
  const reminderDayByOrg = await configByOrg(db, 'OVERDUE_REMINDER_DAY');
  const placeholders = NOT_OVERDUE_STATUSES.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT action_plan_id AS id, organization_id, COALESCE(action_ref, action_number) AS reference,
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
    if (!overdueRunsToday(reminderDayByOrg.get(organizationId), utcDay)) continue;
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

/**
 * Daily: warn the owners of an action plan approaching its deadline (due within
 * DUE_SOON_DAYS and not yet overdue), so the overdue mail is never the first
 * they hear of it. Deduplicated per plan and owner within the window.
 */
export async function runDueSoonReminders(db: Client, clock: Clock): Promise<{ queued: number }> {
  const nowIso = clock.now().toISOString();
  const placeholders = NOT_OVERDUE_STATUSES.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT action_plan_id AS id, organization_id, COALESCE(action_ref, action_number) AS reference,
                 action_description AS title, owner_ids, due_date
            FROM action_plans
           WHERE due_date IS NOT NULL
             AND date(due_date) >= date(?)
             AND date(due_date) <= date(?, '+' || ? || ' days')
             AND status NOT IN (${placeholders})
           LIMIT 1000`,
    args: [nowIso, nowIso, DUE_SOON_DAYS, ...NOT_OVERDUE_STATUSES],
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
          'DUE_SOON_REMINDER',
          id,
          recipient.userId,
          DUE_SOON_DEDUP_DAYS,
          nowIso,
        )
      ) {
        continue;
      }
      await queueNotification(db, organizationId, {
        type: 'DUE_SOON_REMINDER',
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
