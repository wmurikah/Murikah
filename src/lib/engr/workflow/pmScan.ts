/**
 * Preventive-maintenance daily scan: a producer, not a writer of work-order
 * status. It materialises occurrences and enqueues the one-month and two-week
 * reminders. Delivery is the dispatcher's job; this only inserts QUEUED rows.
 *
 * Idempotency: an occurrence exists once per (schedule, due_date). Each reminder
 * is stamped in a guarded write inside a transaction with its enqueue, so a
 * second run the same day changes nothing and cannot double-fire. Time is read
 * from the injected clock and every decision is made on EAT calendar dates.
 *
 * Only automated schedules on an entitled plan fire reminders; every active
 * schedule still materialises occurrences for manual handling.
 */
import type { Client } from '@libsql/client/web';
import type { Clock } from '../time';
import { eatDateString, decidePmActions } from '../time';
import { enqueue, type SqlExecutor } from '../notify';
import type { DeliveryEnv } from '../notify/env';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export interface PmScanOptions {
  orgLimit: number;
  scheduleLimit: number;
}

export interface PmScanSummary {
  orgs: number;
  schedules: number;
  occurrencesCreated: number;
  remind1m: number;
  remind2w: number;
  missed: number;
}

export interface ScheduleRow {
  id: string;
  name: string;
  isAutomated: boolean;
  assignedContractorId: string | null;
  stationId: string | null;
  nextDueDate: string | null;
}

export interface OccurrenceRow {
  id: string;
  dueDate: string;
  status: string;
  notified1mAt: string | null;
  notified2wAt: string | null;
}

/** Users who may allocate PM in this org: the responsible engineers. */
export async function allocatorUserIds(db: Client, orgId: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT DISTINCT u.id AS id
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            JOIN role_permissions rp ON rp.role_id = r.id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE u.org_id = ? AND u.status = 'ACTIVE'
             AND p.key = 'pm.allocate' AND (r.org_id IS NULL OR r.org_id = ?)`,
    args: [orgId, orgId],
  });
  return res.rows.map((r) => String(r.id));
}

export async function pmAutomationEnabled(db: Client, orgId: string): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT p.features_json AS features
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
           WHERE s.org_id = ? AND s.status IN ('TRIALING', 'ACTIVE')
        ORDER BY s.updated_at DESC LIMIT 1`,
    args: [orgId],
  });
  const raw = res.rows[0]?.features;
  if (typeof raw !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Boolean(
      parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).pm_automation,
    );
  } catch {
    return false;
  }
}

interface PmRecipients {
  contractorId: string | null;
  userIds: string[];
}

async function enqueuePmReminder(
  db: SqlExecutor,
  orgId: string,
  occurrenceId: string,
  recipients: PmRecipients,
  templateKey: string,
  subject: string,
  body: string,
): Promise<void> {
  if (recipients.contractorId) {
    await enqueue(db, orgId, {
      recipientType: 'contractor',
      recipientId: recipients.contractorId,
      templateKey,
      subject,
      body,
      entityType: 'pm_occurrence',
      entityId: occurrenceId,
    });
  }
  for (const userId of recipients.userIds) {
    await enqueue(db, orgId, {
      recipientType: 'user',
      recipientId: userId,
      templateKey,
      subject,
      body,
      entityType: 'pm_occurrence',
      entityId: occurrenceId,
    });
  }
}

/**
 * Evaluate one open occurrence against today's EAT date and fire any due
 * reminders exactly once. Each stamp is written in a guarded transaction with
 * its enqueue: only the run that flips the null stamp sends. Shared by the daily
 * scan and the reschedule rule. Returns what fired.
 */
export async function evaluateOccurrence(
  db: Client,
  orgId: string,
  todayEat: string,
  nowIso: string,
  schedule: ScheduleRow,
  occ: OccurrenceRow,
  entitled: boolean,
  recipients: PmRecipients,
): Promise<{ fired1m: boolean; fired2w: boolean; missed: boolean }> {
  const result = { fired1m: false, fired2w: false, missed: false };
  const decision = decidePmActions(todayEat, occ.dueDate, {
    notified1mAt: occ.notified1mAt,
    notified2wAt: occ.notified2wAt,
    allocated: false,
  });
  const canFire = schedule.isAutomated && entitled;

  if (decision.fire1m && canFire) {
    const tx = await db.transaction('write');
    try {
      const stamp = await tx.execute({
        sql: `UPDATE pm_occurrences SET notified_1m_at = ?, status = 'NOTIFIED_1M', updated_at = ?
               WHERE id = ? AND org_id = ? AND notified_1m_at IS NULL`,
        args: [nowIso, nowIso, occ.id, orgId],
      });
      if (stamp.rowsAffected === 1) {
        await enqueuePmReminder(
          tx,
          orgId,
          occ.id,
          recipients,
          'pm_reminder_1m',
          `Maintenance due in about a month: ${schedule.name}`,
          `The maintenance "${schedule.name}" is due on ${occ.dueDate}. Please allocate it.`,
        );
        result.fired1m = true;
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  if (decision.fire2w && canFire) {
    const tx = await db.transaction('write');
    try {
      const stamp = await tx.execute({
        sql: `UPDATE pm_occurrences SET notified_2w_at = ?, status = 'NOTIFIED_2W', updated_at = ?
               WHERE id = ? AND org_id = ? AND notified_2w_at IS NULL`,
        args: [nowIso, nowIso, occ.id, orgId],
      });
      if (stamp.rowsAffected === 1) {
        await enqueuePmReminder(
          tx,
          orgId,
          occ.id,
          recipients,
          'pm_reminder_2w',
          `Maintenance due in two weeks: ${schedule.name}`,
          `The maintenance "${schedule.name}" is due on ${occ.dueDate}. Please allocate it soon.`,
        );
        result.fired2w = true;
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  if (decision.missed) {
    const tx = await db.transaction('write');
    try {
      const stamp = await tx.execute({
        sql: `UPDATE pm_occurrences SET status = 'MISSED', updated_at = ?
               WHERE id = ? AND org_id = ? AND status IN ('SCHEDULED', 'NOTIFIED_1M', 'NOTIFIED_2W')`,
        args: [nowIso, occ.id, orgId],
      });
      if (stamp.rowsAffected === 1) {
        await enqueuePmReminder(
          tx,
          orgId,
          occ.id,
          { contractorId: null, userIds: recipients.userIds },
          'pm_missed',
          `Maintenance missed: ${schedule.name}`,
          `The maintenance "${schedule.name}" due on ${occ.dueDate} was not allocated and is now overdue.`,
        );
        result.missed = true;
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  return result;
}

export async function runPmScan(
  db: Client,
  _env: DeliveryEnv,
  clock: Clock,
  options: PmScanOptions,
): Promise<PmScanSummary> {
  const now = clock.now();
  const nowIso = now.toISOString();
  const todayEat = eatDateString(now);
  const summary: PmScanSummary = {
    orgs: 0,
    schedules: 0,
    occurrencesCreated: 0,
    remind1m: 0,
    remind2w: 0,
    missed: 0,
  };

  const orgRes = await db.execute({
    sql: `SELECT DISTINCT org_id FROM pm_schedules WHERE status = 'ACTIVE' ORDER BY org_id
           LIMIT ?`,
    args: [Math.max(1, Math.min(options.orgLimit, 200))],
  });

  for (const orgRow of orgRes.rows) {
    const orgId = String(orgRow.org_id);
    summary.orgs += 1;
    const entitled = await pmAutomationEnabled(db, orgId);
    const userIds = await allocatorUserIds(db, orgId);

    const schedRes = await db.execute({
      sql: `SELECT id, name, is_automated, assigned_contractor_id, station_id, next_due_date
              FROM pm_schedules
             WHERE org_id = ? AND status = 'ACTIVE'
          ORDER BY created_at LIMIT ?`,
      args: [orgId, Math.max(1, Math.min(options.scheduleLimit, 500))],
    });

    for (const s of schedRes.rows) {
      summary.schedules += 1;
      const schedule: ScheduleRow = {
        id: String(s.id),
        name: String(s.name),
        isAutomated: Number(s.is_automated) === 1,
        assignedContractorId:
          s.assigned_contractor_id == null ? null : String(s.assigned_contractor_id),
        stationId: s.station_id == null ? null : String(s.station_id),
        nextDueDate: s.next_due_date == null ? null : String(s.next_due_date),
      };
      const recipients: PmRecipients = { contractorId: schedule.assignedContractorId, userIds };

      // Ensure the current occurrence exists for next_due_date (check then insert).
      if (schedule.nextDueDate) {
        const existing = await db.execute({
          sql: `SELECT id FROM pm_occurrences
                 WHERE org_id = ? AND pm_schedule_id = ? AND due_date = ? LIMIT 1`,
          args: [orgId, schedule.id, schedule.nextDueDate],
        });
        if (!existing.rows[0]) {
          await db.execute({
            sql: `INSERT INTO pm_occurrences (id, org_id, pm_schedule_id, due_date, status)
                  VALUES (?, ?, ?, ?, 'SCHEDULED')`,
            args: [newId(), orgId, schedule.id, schedule.nextDueDate],
          });
          summary.occurrencesCreated += 1;
        }
      }

      // Evaluate every open occurrence of this schedule.
      const occRes = await db.execute({
        sql: `SELECT id, due_date, status, notified_1m_at, notified_2w_at
                FROM pm_occurrences
               WHERE org_id = ? AND pm_schedule_id = ?
                 AND status IN ('SCHEDULED', 'NOTIFIED_1M', 'NOTIFIED_2W')
            ORDER BY due_date`,
        args: [orgId, schedule.id],
      });
      for (const o of occRes.rows) {
        const occ: OccurrenceRow = {
          id: String(o.id),
          dueDate: String(o.due_date),
          status: String(o.status),
          notified1mAt: o.notified_1m_at == null ? null : String(o.notified_1m_at),
          notified2wAt: o.notified_2w_at == null ? null : String(o.notified_2w_at),
        };
        const fired = await evaluateOccurrence(
          db,
          orgId,
          todayEat,
          nowIso,
          schedule,
          occ,
          entitled,
          recipients,
        );
        if (fired.fired1m) summary.remind1m += 1;
        if (fired.fired2w) summary.remind2w += 1;
        if (fired.missed) summary.missed += 1;
      }
    }
  }

  return summary;
}
