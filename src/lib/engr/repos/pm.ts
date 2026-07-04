/**
 * Preventive-maintenance repository: schedules, occurrences and the reschedule
 * rule. Org-scoped throughout. Occurrence status is moved by the scan and the
 * allocation path, not here, except the reschedule rule which recomputes stamps
 * when a due date moves.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { staleStamps, eatDateString, systemClock } from '../time';
import {
  allocatorUserIds,
  pmAutomationEnabled,
  evaluateOccurrence,
  type ScheduleRow,
  type OccurrenceRow,
} from '../workflow/pmScan';

export { pmAutomationEnabled };

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export type PmFrequencyValue =
  | 'WEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'BIANNUAL'
  | 'ANNUAL'
  | 'CUSTOM_DAYS';

const VALID_FREQUENCIES = new Set<PmFrequencyValue>([
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'BIANNUAL',
  'ANNUAL',
  'CUSTOM_DAYS',
]);

export interface ScheduleInput {
  name: string;
  assetId: string | null;
  stationId: string | null;
  categoryId: string | null;
  frequency: string;
  intervalDays: number | null;
  assignedContractorId: string | null;
  checklistTemplateId: string | null;
  slaId: string | null;
  firstDueDate: string | null;
  isAutomated: boolean;
}

export type ScheduleResult =
  | { ok: true; id: string }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; message: string };

function validate(input: ScheduleInput): string | null {
  if (!input.name.trim()) return 'A name is required.';
  if (!input.stationId && !input.assetId && !input.categoryId) {
    return 'Choose a station, an asset or a category.';
  }
  if (!VALID_FREQUENCIES.has(input.frequency as PmFrequencyValue))
    return 'Choose a valid frequency.';
  if (input.frequency === 'CUSTOM_DAYS' && (!input.intervalDays || input.intervalDays < 1)) {
    return 'Custom frequency needs a day interval.';
  }
  return null;
}

export async function createSchedule(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: ScheduleInput,
): Promise<ScheduleResult> {
  const problem = validate(input);
  if (problem) return { ok: false, code: 'invalid', message: problem };
  const entitled = await pmAutomationEnabled(db, ctx.orgId);
  const automated = input.isAutomated && entitled ? 1 : 0;
  const id = newId();
  await db.execute({
    sql: `INSERT INTO pm_schedules
            (id, org_id, name, asset_id, station_id, category_id, frequency, interval_days,
             is_automated, assigned_contractor_id, checklist_template_id, sla_id, next_due_date, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    args: [
      id,
      ctx.orgId,
      input.name.trim(),
      input.assetId,
      input.stationId,
      input.categoryId,
      input.frequency,
      input.frequency === 'CUSTOM_DAYS' ? input.intervalDays : null,
      automated,
      input.assignedContractorId,
      input.checklistTemplateId,
      input.slaId,
      input.firstDueDate,
    ],
  });
  await db.execute({
    sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (?, ?, 'pm.schedule.create', 'pm_schedule', ?, ?)`,
    args: [
      ctx.orgId,
      ctx.userId,
      id,
      JSON.stringify({ name: input.name.trim(), automated: automated === 1 }),
    ],
  });
  return { ok: true, id };
}

interface CurrentSchedule {
  id: string;
  name: string;
  isAutomated: boolean;
  assignedContractorId: string | null;
  stationId: string | null;
  nextDueDate: string | null;
  frequency: string;
}

async function loadSchedule(
  db: Client,
  orgId: string,
  id: string,
): Promise<CurrentSchedule | null> {
  const res = await db.execute({
    sql: `SELECT id, name, is_automated, assigned_contractor_id, station_id, next_due_date, frequency
            FROM pm_schedules WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    isAutomated: Number(row.is_automated) === 1,
    assignedContractorId:
      row.assigned_contractor_id == null ? null : String(row.assigned_contractor_id),
    stationId: row.station_id == null ? null : String(row.station_id),
    nextDueDate: row.next_due_date == null ? null : String(row.next_due_date),
    frequency: String(row.frequency),
  };
}

export async function updateSchedule(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: ScheduleInput,
): Promise<ScheduleResult> {
  const problem = validate(input);
  if (problem) return { ok: false, code: 'invalid', message: problem };
  const current = await loadSchedule(db, ctx.orgId, id);
  if (!current) return { ok: false, code: 'not_found', message: 'Schedule not found.' };
  const entitled = await pmAutomationEnabled(db, ctx.orgId);
  const automated = input.isAutomated && entitled ? 1 : 0;

  await db.execute({
    sql: `UPDATE pm_schedules
             SET name = ?, asset_id = ?, station_id = ?, category_id = ?, frequency = ?,
                 interval_days = ?, is_automated = ?, assigned_contractor_id = ?,
                 checklist_template_id = ?, sla_id = ?, next_due_date = ?, updated_at = ?
           WHERE id = ? AND org_id = ?`,
    args: [
      input.name.trim(),
      input.assetId,
      input.stationId,
      input.categoryId,
      input.frequency,
      input.frequency === 'CUSTOM_DAYS' ? input.intervalDays : null,
      automated,
      input.assignedContractorId,
      input.checklistTemplateId,
      input.slaId,
      input.firstDueDate,
      new Date().toISOString(),
      id,
      ctx.orgId,
    ],
  });

  if (input.firstDueDate && input.firstDueDate !== current.nextDueDate) {
    await reschedule(db, ctx.orgId, id, current.nextDueDate, input.firstDueDate);
  }
  return { ok: true, id };
}

/**
 * The reschedule rule: when a schedule's due date moves, move its open
 * occurrence to the new date, clear any stamp that no longer matches the new
 * windows so the reminder can re-fire, enqueue a short correction notice, then
 * evaluate the occurrence once now in case the new date already sits inside a
 * window.
 */
async function reschedule(
  db: Client,
  orgId: string,
  scheduleId: string,
  oldDue: string | null,
  newDue: string,
): Promise<void> {
  if (!oldDue) return;
  const occRes = await db.execute({
    sql: `SELECT id, status, notified_1m_at, notified_2w_at FROM pm_occurrences
           WHERE org_id = ? AND pm_schedule_id = ? AND due_date = ?
             AND status IN ('SCHEDULED', 'NOTIFIED_1M', 'NOTIFIED_2W') LIMIT 1`,
    args: [orgId, scheduleId, oldDue],
  });
  const occ = occRes.rows[0];
  if (!occ) return;

  const occId = String(occ.id);
  const notified1mAt = occ.notified_1m_at == null ? null : String(occ.notified_1m_at);
  const notified2wAt = occ.notified_2w_at == null ? null : String(occ.notified_2w_at);
  const now = systemClock.now();
  const today = eatDateString(now);
  const nowIso = now.toISOString();

  const { clear1m, clear2w } = staleStamps(today, newDue, {
    notified1mAt,
    notified2wAt,
    allocated: false,
  });
  const next1m = clear1m ? null : notified1mAt;
  const next2w = clear2w ? null : notified2wAt;
  const status = next2w ? 'NOTIFIED_2W' : next1m ? 'NOTIFIED_1M' : 'SCHEDULED';

  await db.execute({
    sql: `UPDATE pm_occurrences SET due_date = ?, notified_1m_at = ?, notified_2w_at = ?, status = ?, updated_at = ?
           WHERE id = ? AND org_id = ?`,
    args: [newDue, next1m, next2w, status, nowIso, occId, orgId],
  });

  const schedule = await loadSchedule(db, orgId, scheduleId);
  if (!schedule) return;
  const userIds = await allocatorUserIds(db, orgId);
  if (schedule.assignedContractorId) {
    await enqueue(db, orgId, {
      recipientType: 'contractor',
      recipientId: schedule.assignedContractorId,
      templateKey: 'pm_reminder_updated',
      subject: `Maintenance date changed: ${schedule.name}`,
      body: `The maintenance "${schedule.name}" is now due on ${newDue}.`,
      entityType: 'pm_occurrence',
      entityId: occId,
    });
  }
  for (const userId of userIds) {
    await enqueue(db, orgId, {
      recipientType: 'user',
      recipientId: userId,
      templateKey: 'pm_reminder_updated',
      subject: `Maintenance date changed: ${schedule.name}`,
      body: `The maintenance "${schedule.name}" is now due on ${newDue}.`,
      entityType: 'pm_occurrence',
      entityId: occId,
    });
  }

  // Fire now if the new date already sits inside a window.
  const entitled = await pmAutomationEnabled(db, orgId);
  const scheduleRow: ScheduleRow = {
    id: schedule.id,
    name: schedule.name,
    isAutomated: schedule.isAutomated,
    assignedContractorId: schedule.assignedContractorId,
    stationId: schedule.stationId,
    nextDueDate: newDue,
  };
  const occRow: OccurrenceRow = {
    id: occId,
    dueDate: newDue,
    status,
    notified1mAt: next1m,
    notified2wAt: next2w,
  };
  await evaluateOccurrence(db, orgId, today, nowIso, scheduleRow, occRow, entitled, {
    contractorId: schedule.assignedContractorId,
    userIds,
  });
}

export async function setScheduleStatus(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
): Promise<ScheduleResult> {
  const res = await db.execute({
    sql: `UPDATE pm_schedules SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
    args: [status, new Date().toISOString(), id, ctx.orgId],
  });
  if (res.rowsAffected === 0)
    return { ok: false, code: 'not_found', message: 'Schedule not found.' };
  await db.execute({
    sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (?, ?, 'pm.schedule.status', 'pm_schedule', ?, ?)`,
    args: [ctx.orgId, ctx.userId, id, JSON.stringify({ status })],
  });
  return { ok: true, id };
}

// ---- reads ------------------------------------------------------------------

export interface ScheduleListRow {
  id: string;
  name: string;
  frequency: string;
  isAutomated: boolean;
  stationName: string | null;
  contractorName: string | null;
  nextDueDate: string | null;
  status: string;
}

export async function listSchedules(db: Client, orgId: string): Promise<ScheduleListRow[]> {
  const res = await db.execute({
    sql: `SELECT ps.id, ps.name, ps.frequency, ps.is_automated, ps.next_due_date, ps.status,
                 st.name AS station_name, c.name AS contractor_name
            FROM pm_schedules ps
            LEFT JOIN stations st ON st.id = ps.station_id
            LEFT JOIN contractors c ON c.id = ps.assigned_contractor_id
           WHERE ps.org_id = ?
        ORDER BY ps.status, ps.next_due_date`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    frequency: String(row.frequency),
    isAutomated: Number(row.is_automated) === 1,
    stationName: row.station_name == null ? null : String(row.station_name),
    contractorName: row.contractor_name == null ? null : String(row.contractor_name),
    nextDueDate: row.next_due_date == null ? null : String(row.next_due_date),
    status: String(row.status),
  }));
}

export interface ScheduleDetail extends ScheduleListRow {
  assetId: string | null;
  stationId: string | null;
  categoryId: string | null;
  intervalDays: number | null;
  assignedContractorId: string | null;
  checklistTemplateId: string | null;
  slaId: string | null;
  lastRunDate: string | null;
}

export async function getSchedule(
  db: Client,
  orgId: string,
  id: string,
): Promise<ScheduleDetail | null> {
  const res = await db.execute({
    sql: `SELECT ps.*, st.name AS station_name, c.name AS contractor_name
            FROM pm_schedules ps
            LEFT JOIN stations st ON st.id = ps.station_id
            LEFT JOIN contractors c ON c.id = ps.assigned_contractor_id
           WHERE ps.id = ? AND ps.org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    frequency: String(row.frequency),
    isAutomated: Number(row.is_automated) === 1,
    stationName: row.station_name == null ? null : String(row.station_name),
    contractorName: row.contractor_name == null ? null : String(row.contractor_name),
    nextDueDate: row.next_due_date == null ? null : String(row.next_due_date),
    status: String(row.status),
    assetId: row.asset_id == null ? null : String(row.asset_id),
    stationId: row.station_id == null ? null : String(row.station_id),
    categoryId: row.category_id == null ? null : String(row.category_id),
    intervalDays: row.interval_days == null ? null : Number(row.interval_days),
    assignedContractorId:
      row.assigned_contractor_id == null ? null : String(row.assigned_contractor_id),
    checklistTemplateId:
      row.checklist_template_id == null ? null : String(row.checklist_template_id),
    slaId: row.sla_id == null ? null : String(row.sla_id),
    lastRunDate: row.last_run_date == null ? null : String(row.last_run_date),
  };
}

export interface OccurrenceListRow {
  id: string;
  dueDate: string;
  status: string;
  notified1m: boolean;
  notified2w: boolean;
  scheduleName: string;
}

export async function listUpcomingOccurrences(
  db: Client,
  orgId: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<OccurrenceListRow[]> {
  const args: (string | number)[] = [orgId];
  // An optional week window, drilled from the "Upcoming maintenance" chart: from
  // inclusive, to exclusive, both YYYY-MM-DD against the due date.
  let where = 'o.org_id = ?';
  if (opts.from) {
    where += ' AND o.due_date >= ?';
    args.push(opts.from);
  }
  if (opts.to) {
    where += ' AND o.due_date < ?';
    args.push(opts.to);
  }
  args.push(Math.max(1, Math.min(opts.limit ?? 200, 500)));
  const res = await db.execute({
    sql: `SELECT o.id, o.due_date, o.status, o.notified_1m_at, o.notified_2w_at, s.name AS schedule_name
            FROM pm_occurrences o
            JOIN pm_schedules s ON s.id = o.pm_schedule_id
           WHERE ${where}
        ORDER BY o.due_date LIMIT ?`,
    args,
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    dueDate: String(row.due_date),
    status: String(row.status),
    notified1m: row.notified_1m_at != null,
    notified2w: row.notified_2w_at != null,
    scheduleName: String(row.schedule_name),
  }));
}

export interface ChecklistItem {
  itemText: string;
  expectedResult: string | null;
}

export interface OccurrenceDetail {
  id: string;
  dueDate: string;
  status: string;
  notified1mAt: string | null;
  notified2wAt: string | null;
  scheduleId: string;
  scheduleName: string;
  stationName: string | null;
  contractorName: string | null;
  checklist: ChecklistItem[];
}

export async function getOccurrence(
  db: Client,
  orgId: string,
  id: string,
): Promise<OccurrenceDetail | null> {
  const res = await db.execute({
    sql: `SELECT o.id, o.due_date, o.status, o.notified_1m_at, o.notified_2w_at,
                 s.id AS schedule_id, s.name AS schedule_name, s.checklist_template_id,
                 st.name AS station_name, c.name AS contractor_name
            FROM pm_occurrences o
            JOIN pm_schedules s ON s.id = o.pm_schedule_id
            LEFT JOIN stations st ON st.id = s.station_id
            LEFT JOIN contractors c ON c.id = s.assigned_contractor_id
           WHERE o.id = ? AND o.org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const templateId = row.checklist_template_id == null ? null : String(row.checklist_template_id);
  let checklist: ChecklistItem[] = [];
  if (templateId) {
    const items = await db.execute({
      sql: `SELECT item_text, expected_result FROM pm_checklist_items
             WHERE org_id = ? AND template_id = ? ORDER BY sort_order, created_at`,
      args: [orgId, templateId],
    });
    checklist = items.rows.map((it) => ({
      itemText: String(it.item_text),
      expectedResult: it.expected_result == null ? null : String(it.expected_result),
    }));
  }
  return {
    id: String(row.id),
    dueDate: String(row.due_date),
    status: String(row.status),
    notified1mAt: row.notified_1m_at == null ? null : String(row.notified_1m_at),
    notified2wAt: row.notified_2w_at == null ? null : String(row.notified_2w_at),
    scheduleId: String(row.schedule_id),
    scheduleName: String(row.schedule_name),
    stationName: row.station_name == null ? null : String(row.station_name),
    contractorName: row.contractor_name == null ? null : String(row.contractor_name),
    checklist,
  };
}

export interface Option {
  id: string;
  name: string;
}

export async function listChecklistTemplates(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, name FROM pm_checklist_templates WHERE org_id = ? ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

export async function listActiveContractors(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, name FROM contractors
           WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}
