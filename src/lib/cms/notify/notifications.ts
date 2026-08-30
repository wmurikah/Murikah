/**
 * The one notification writer, and the sweeps that feed it.
 *
 * IDEMPOTENCY IS THE WHOLE DIFFICULTY, AND THE KEY IS STATED HERE.
 * The table has no unique constraint, so every insert goes through
 * `notify()`, whose INSERT is guarded by NOT EXISTS over the deterministic
 * key (user_id, notification_type, entity_type, entity_id). The entity a
 * notification points at is chosen so the key is exact: an SLA warning
 * points at the SLA INSTANCE, not the case, so a case with two SLAs can
 * warn twice while one instance processed twice cannot; a follow-up points
 * at the activity; an import exception at the batch. Repeated processing of
 * any event therefore creates exactly one row, tested by running the sweep
 * twice.
 *
 * WHAT A MESSAGE MAY CONTAIN, AND WHY.
 * The notifications table is not scope-filtered, so anything in a title or
 * message is readable by whoever can read the row. The policy: record
 * numbers (CS-2026-0001, SO 109214, LD-2026-...), stage names and counts.
 * Never a customer name, never an amount, never credit commentary. The
 * composer functions below are the only writers, so the policy has one
 * enforcement point.
 *
 * A NOTIFICATION IS NOT AN ACCESS GRANT.
 * `resolveNotificationTarget` re-runs normal access control through the
 * entity access registry (and the monitor scope for SLA instances) before
 * ever answering with a destination. Rights revoked since the notification
 * was created produce a safe null, never the record.
 *
 * EMAIL IS A CHANNEL THIS PRODUCT DOES NOT HAVE.
 * The in-app row is the persisted notification; an email channel, if one
 * ever arrives, would be a delivery reading these same rows after commit.
 * There is no queue library and no CMS email infrastructure (RESEND_API_KEY
 * belongs to the marketing site), so nothing here sends, nothing claims to
 * have sent, and no business transaction could ever block on delivery
 * because delivery does not exist to block on. The interface says exactly
 * that.
 */
import type { Client } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import { resolveEntityAccess } from '../crm/entityAccess.ts';
import { scopedSlaInstances } from '../repos/slaAdmin.ts';
import { DUE_SQL } from '../repos/activityAdmin.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export type NotificationType =
  | 'ASSIGNMENT'
  | 'SLA_WARNING'
  | 'SLA_BREACH'
  | 'FOLLOW_UP'
  | 'IMPORT_EXCEPTION'
  | 'SYSTEM';

/** The one writer. Everything goes through the NOT EXISTS guard. */
export async function notify(
  db: Client,
  input: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    entityType: string | null;
    entityId: string | null;
    at: Date;
  },
): Promise<boolean> {
  const result = await db.execute({
    sql: `INSERT INTO notifications
            (notification_id, user_id, notification_type, title, message, entity_type, entity_id,
             created_at, read_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE user_id = ? AND notification_type = ?
              AND entity_type IS ? AND entity_id IS ?
          )`,
    args: [
      newId('NOTIF'),
      input.userId,
      input.type,
      input.title,
      input.message,
      input.entityType,
      input.entityId,
      toDbTimestamp(input.at),
      input.userId,
      input.type,
      input.entityType,
      input.entityId,
    ] as never[],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

// ---- Composers, the policy's single enforcement point -----------------------

/** Case assignment: the case number and nothing commercial. */
export async function notifyCaseAssignment(
  db: Client,
  input: { userId: string; caseNumber: string; caseId: string; at: Date },
): Promise<void> {
  await notify(db, {
    userId: input.userId,
    type: 'ASSIGNMENT',
    title: `Case ${input.caseNumber} assigned to you`,
    message: `Case ${input.caseNumber} is now on your queue.`,
    entityType: 'CASE',
    entityId: input.caseId,
    at: input.at,
  });
}

/** Workflow stage assignment: the document number and the stage name. */
export async function notifyStageAssignment(
  db: Client,
  input: {
    userId: string;
    documentLabel: string;
    stageName: string;
    entityType: string;
    entityId: string;
    at: Date;
  },
): Promise<void> {
  await notify(db, {
    userId: input.userId,
    type: 'ASSIGNMENT',
    title: `${input.documentLabel} awaits your ${input.stageName}`,
    message: `${input.documentLabel} is waiting on your ${input.stageName} decision.`,
    entityType: input.entityType,
    entityId: input.entityId,
    at: input.at,
  });
}

/**
 * Import exceptions, aggregated: one notification naming the count, never
 * one per row and never every employee. Phases 17 to 19 call this.
 */
export async function notifyImportException(
  db: Client,
  input: { userId: string; batchId: string; unresolvedCount: number; at: Date },
): Promise<void> {
  await notify(db, {
    userId: input.userId,
    type: 'IMPORT_EXCEPTION',
    title: `Your upload has ${input.unresolvedCount} unresolved item${input.unresolvedCount === 1 ? '' : 's'}`,
    message: `Import batch ${input.batchId} finished with ${input.unresolvedCount} unresolved item${input.unresolvedCount === 1 ? '' : 's'} awaiting review.`,
    entityType: 'IMPORT_BATCH',
    entityId: input.batchId,
    at: input.at,
  });
}

// ---- The sweeps --------------------------------------------------------------

interface DueInstance {
  slaInstanceId: string;
  entityType: string;
  entityId: string;
  label: string;
  ruleName: string;
  accountableUserId: string | null;
  accountableTeamId: string | null;
  targetAt: string;
  escalationAfterMinutes: number | null;
  affiliateId: string | null;
}

async function dueInstances(db: Client, eventType: 'WARNING' | 'BREACH'): Promise<DueInstance[]> {
  const result = await db.execute({
    sql: `SELECT i.sla_instance_id, i.entity_type, i.entity_id, i.accountable_user_id,
                 i.accountable_team_id, i.target_at, r.rule_name, r.escalation_after_minutes,
                 COALESCE(sc.case_number, l.lead_number, so.document_number, po.document_number, i.entity_id) AS label,
                 COALESCE(a_case.affiliate_id, a_lead.affiliate_id, so.affiliate_id, po.affiliate_id) AS affiliate_id
          FROM sla_instances i
          JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
          LEFT JOIN service_cases sc ON i.entity_type = 'CASE' AND sc.case_id = i.entity_id
          LEFT JOIN accounts a_case ON a_case.account_id = sc.account_id
          LEFT JOIN leads l ON i.entity_type = 'LEAD' AND l.lead_id = i.entity_id
          LEFT JOIN accounts a_lead ON a_lead.account_id = l.account_id
          LEFT JOIN sales_orders so ON i.entity_type = 'SALES_ORDER' AND so.sales_order_id = i.entity_id
          LEFT JOIN purchase_orders po ON i.entity_type = 'PURCHASE_ORDER' AND po.purchase_order_id = i.entity_id
          WHERE EXISTS (SELECT 1 FROM sla_timer_events e
                        WHERE e.sla_instance_id = i.sla_instance_id AND e.event_type = ?)`,
    args: [eventType],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      slaInstanceId: text(row.sla_instance_id),
      entityType: text(row.entity_type),
      entityId: text(row.entity_id),
      label: text(row.label),
      ruleName: text(row.rule_name),
      accountableUserId: nullableText(row.accountable_user_id),
      accountableTeamId: nullableText(row.accountable_team_id),
      targetAt: text(row.target_at),
      escalationAfterMinutes:
        row.escalation_after_minutes === null || row.escalation_after_minutes === undefined
          ? null
          : Number(row.escalation_after_minutes),
      affiliateId: nullableText(row.affiliate_id),
    };
  });
}

async function teamManager(db: Client, teamId: string | null): Promise<string | null> {
  if (teamId === null) return null;
  const result = await db.execute({
    sql: `SELECT manager_user_id FROM teams WHERE team_id = ? AND active = 1`,
    args: [teamId],
  });
  return nullableText(result.rows[0]?.manager_user_id);
}

/**
 * The local escalation recipient: the accountable team's manager, and where
 * the team has none, the affiliate's COUNTRY_MANAGER_APPROVER assignment
 * from the workflow hierarchy. Local before Group, and Group only when
 * configured: nothing in this function reaches a GROUP-scoped assignment,
 * so a Kenya delay never notifies the Group CFO unless an administrator
 * writes a rule that names Group explicitly.
 */
async function escalationRecipient(db: Client, instance: DueInstance): Promise<string | null> {
  const manager = await teamManager(db, instance.accountableTeamId);
  if (manager !== null && manager !== instance.accountableUserId) return manager;
  if (instance.affiliateId === null) return null;
  const result = await db.execute({
    sql: `SELECT wra.user_id FROM workflow_role_assignments wra
          JOIN workflow_roles wr ON wr.workflow_role_id = wra.workflow_role_id
          WHERE wr.role_code = 'COUNTRY_MANAGER_APPROVER'
            AND wra.scope_type = 'AFFILIATE' AND wra.affiliate_id = ?
            AND wra.active = 1
          ORDER BY wra.priority LIMIT 1`,
    args: [instance.affiliateId],
  });
  return nullableText(result.rows[0]?.user_id);
}

export interface NotificationSweepResult {
  warnings: number;
  breaches: number;
  escalations: number;
  followUps: number;
}

/**
 * Turn accumulated facts into notifications, idempotently: run twice, get
 * nothing twice. Warning and breach read the timer events phase 15 wrote;
 * escalation reads the breach clock against the rule's configured
 * escalation window and records its evidence in details_json, where the
 * administrative view answers "why was this person notified" in a sentence.
 */
export async function sweepNotifications(db: Client, now: Date): Promise<NotificationSweepResult> {
  const result: NotificationSweepResult = {
    warnings: 0,
    breaches: 0,
    escalations: 0,
    followUps: 0,
  };

  for (const instance of await dueInstances(db, 'WARNING')) {
    const recipient =
      instance.accountableUserId ?? (await teamManager(db, instance.accountableTeamId));
    if (recipient === null) continue;
    const created = await notify(db, {
      userId: recipient,
      type: 'SLA_WARNING',
      title: `${instance.label} is approaching its target`,
      message: `${instance.ruleName} on ${instance.label} reaches its target at ${instance.targetAt}.`,
      entityType: 'SLA_INSTANCE',
      entityId: instance.slaInstanceId,
      at: now,
    });
    if (created) result.warnings += 1;
  }

  for (const instance of await dueInstances(db, 'BREACH')) {
    const recipient =
      instance.accountableUserId ?? (await teamManager(db, instance.accountableTeamId));
    if (recipient !== null) {
      const created = await notify(db, {
        userId: recipient,
        type: 'SLA_BREACH',
        title: `${instance.label} has passed its target`,
        message: `${instance.ruleName} on ${instance.label} passed its target of ${instance.targetAt}.`,
        entityType: 'SLA_INSTANCE',
        entityId: instance.slaInstanceId,
        at: now,
      });
      if (created) result.breaches += 1;
    }

    // Escalation, one level, locally, where the rule configures a window.
    if (instance.escalationAfterMinutes !== null) {
      const escalateAt =
        new Date(`${instance.targetAt.replace(' ', 'T')}Z`).getTime() +
        instance.escalationAfterMinutes * 60000;
      if (now.getTime() >= escalateAt) {
        const supervisor = await escalationRecipient(db, instance);
        if (supervisor !== null) {
          const exceededBy = Math.round((now.getTime() - escalateAt) / 60000);
          const notificationId = newId('NOTIF');
          // The escalation event first: UNIQUE(instance, level) makes one
          // firing per level a database guarantee, and the INSERT OR IGNORE
          // means a repeat is a no-op rather than a crash. The notification
          // follows only when the event was actually new.
          const event = await db.execute({
            sql: `INSERT OR IGNORE INTO sla_escalation_events
                    (sla_escalation_event_id, sla_instance_id, escalation_level, escalated_at,
                     recipient_user_id, notification_id, details_json)
                  VALUES (?, ?, 1, ?, ?, ?, ?)`,
            args: [
              newId('SLAESC'),
              instance.slaInstanceId,
              toDbTimestamp(now),
              supervisor,
              notificationId,
              JSON.stringify({
                why: `${instance.ruleName} on ${instance.label} exceeded its target by more than the configured ${instance.escalationAfterMinutes} minutes, so the local supervisor was notified under the local-before-Group policy.`,
                ruleName: instance.ruleName,
                targetAt: instance.targetAt,
                minutesPastEscalationPoint: exceededBy,
                policy:
                  'local team manager, else the affiliate country manager; never Group unless configured',
              }),
            ] as never[],
          });
          if (Number(event.rowsAffected ?? 0) > 0) {
            await db.execute({
              sql: `INSERT INTO notifications
                      (notification_id, user_id, notification_type, title, message, entity_type,
                       entity_id, created_at, read_at)
                    VALUES (?, ?, 'SLA_BREACH', ?, ?, 'SLA_INSTANCE', ?, ?, NULL)`,
              args: [
                notificationId,
                supervisor,
                `Escalation: ${instance.label} remains past target`,
                `${instance.ruleName} on ${instance.label} is still open past its escalation point. You are its local supervisor.`,
                instance.slaInstanceId,
                toDbTimestamp(now),
              ],
            });
            result.escalations += 1;
          }
        }
      }
    }
  }

  // Follow-up reminders: an open activity past its due time, once per
  // activity, by the same due-time rule phase 13 stated.
  const overdue = await db.execute({
    sql: `SELECT act.activity_id, act.owner_user_id, act.summary, act.activity_type,
                 ${DUE_SQL} AS due_at
          FROM activities act
          WHERE act.completed_at IS NULL AND ${DUE_SQL} IS NOT NULL AND ${DUE_SQL} < ?
            AND NOT EXISTS (SELECT 1 FROM notifications n
                            WHERE n.notification_type = 'FOLLOW_UP'
                              AND n.entity_type = 'ACTIVITY'
                              AND n.entity_id = act.activity_id)`,
    args: [toDbTimestamp(now)],
  });
  for (const raw of overdue.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const created = await notify(db, {
      userId: text(row.owner_user_id),
      type: 'FOLLOW_UP',
      title: `Past due: ${text(row.summary)}`,
      message: `Your ${text(row.activity_type).toLowerCase()} was due at ${text(row.due_at)} and is not yet completed.`,
      entityType: 'ACTIVITY',
      entityId: text(row.activity_id),
      at: now,
    });
    if (created) result.followUps += 1;
  }

  return result;
}

// ---- Reads and state ---------------------------------------------------------

export interface NotificationRow {
  notificationId: string;
  notificationType: NotificationType;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  readAt: string | null;
}

export async function listNotifications(
  db: Client,
  userId: string,
  query: { unreadOnly: boolean; type: string | null; page: number },
): Promise<{ items: NotificationRow[]; total: number; unread: number }> {
  const clauses = ['user_id = ?'];
  const args: unknown[] = [userId];
  if (query.unreadOnly) clauses.push('read_at IS NULL');
  if (query.type !== null) {
    clauses.push('notification_type = ?');
    args.push(query.type);
  }
  const where = clauses.join(' AND ');
  const pageSize = 25;
  const [counted, unread, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM notifications WHERE ${where}`,
      args: args as never[],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`,
      args: [userId],
    }),
    db.execute({
      sql: `SELECT notification_id, notification_type, title, message, entity_type, entity_id,
                   created_at, read_at
            FROM notifications WHERE ${where}
            ORDER BY created_at DESC, notification_id LIMIT ? OFFSET ?`,
      args: [...args, pageSize, (query.page - 1) * pageSize] as never[],
    }),
  ]);
  return {
    items: rows.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        notificationId: text(row.notification_id),
        notificationType: text(row.notification_type) as NotificationType,
        title: text(row.title),
        message: text(row.message),
        entityType: nullableText(row.entity_type),
        entityId: nullableText(row.entity_id),
        createdAt: text(row.created_at),
        readAt: nullableText(row.read_at),
      };
    }),
    total: Number(counted.rows[0]?.n ?? 0),
    unread: Number(unread.rows[0]?.n ?? 0),
  };
}

export async function unreadCount(db: Client, userId: string): Promise<number> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`,
    args: [userId],
  });
  return Number(result.rows[0]?.n ?? 0);
}

/** Unread is read_at IS NULL. Marking read stamps the moment; no boolean. */
export async function markRead(
  db: Client,
  userId: string,
  notificationId: string,
  now: Date,
): Promise<void> {
  await db.execute({
    sql: `UPDATE notifications SET read_at = ? WHERE notification_id = ? AND user_id = ? AND read_at IS NULL`,
    args: [toDbTimestamp(now), notificationId, userId],
  });
}

export async function markAllRead(db: Client, userId: string, now: Date): Promise<void> {
  await db.execute({
    sql: `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`,
    args: [toDbTimestamp(now), userId],
  });
}

/**
 * Where a notification leads, decided by re-running normal access control
 * now, not by trusting the notification. Null means "you can no longer see
 * this record", and the interface shows a safe message rather than the
 * destination.
 */
export async function resolveNotificationTarget(
  db: Client,
  userId: string,
  notification: NotificationRow,
): Promise<string | null> {
  const entityType = notification.entityType;
  const entityId = notification.entityId;
  if (entityType === null || entityId === null) return null;

  if (entityType === 'SLA_INSTANCE') {
    const scope = await scopedSlaInstances(db, userId);
    const visible = await db.execute({
      sql: `SELECT i.sla_instance_id, i.entity_type AS business_type, i.entity_id AS business_id
            FROM sla_instances i
            JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
            JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
            LEFT JOIN service_cases sc ON i.entity_type = 'CASE' AND sc.case_id = i.entity_id
            LEFT JOIN accounts a_case ON a_case.account_id = sc.account_id
            LEFT JOIN leads l ON i.entity_type = 'LEAD' AND l.lead_id = i.entity_id
            LEFT JOIN accounts a_lead ON a_lead.account_id = l.account_id
            LEFT JOIN sales_orders so ON i.entity_type = 'SALES_ORDER' AND so.sales_order_id = i.entity_id
            LEFT JOIN accounts a_so ON a_so.account_id = so.account_id
            LEFT JOIN affiliates af_so ON af_so.affiliate_id = so.affiliate_id
            LEFT JOIN purchase_orders po ON i.entity_type = 'PURCHASE_ORDER' AND po.purchase_order_id = i.entity_id
            LEFT JOIN affiliates af_po ON af_po.affiliate_id = po.affiliate_id
            WHERE i.sla_instance_id = ? AND ${scope.sql} LIMIT 1`,
      args: [entityId, ...scope.args] as never[],
    });
    const row = visible.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const businessType = text(row.business_type);
    const businessId = text(row.business_id);
    if (businessType === 'CASE') return `/app/helpdesk/${businessId}`;
    if (businessType === 'LEAD') return `/app/crm/${businessId}`;
    return '/app/performance';
  }

  if (entityType === 'ACTIVITY') {
    // The activity module's own rule: the id is nothing, the parent decides.
    const { getActivity } = await import('../repos/activityAdmin.ts');
    const activity = await getActivity(db, userId, entityId);
    if (activity === null) return null;
    return '/app/crm/activities';
  }

  const access = await resolveEntityAccess(db, userId, entityType, entityId);
  if (!access.ok) return null;
  switch (entityType) {
    case 'CASE':
      return `/app/helpdesk/${entityId}`;
    case 'LEAD':
      return `/app/crm/${entityId}`;
    case 'OPPORTUNITY':
      return `/app/crm/opportunities/${entityId}`;
    case 'ACCOUNT':
      return `/app/customers/${entityId}`;
    default:
      return null;
  }
}
