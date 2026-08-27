/**
 * Reads and writes for SLA configuration, and the monitor.
 *
 * CONFIGURATION CHANGES ARE AUDITED; TIMER EVENTS ARE NOT COPIED.
 * `sla_timer_events` is the timer's own history. Only profile, rule and
 * calendar changes write `audit_events`, because those are somebody changing
 * the system rather than the clock running.
 *
 * THE MONITOR IS SCOPE-FILTERED THROUGH THE ENTITY EACH INSTANCE MEASURES.
 * An instance is polymorphic, so the scope columns come through LEFT JOINs
 * to the entity tables and collapse with COALESCE: a case reaches country
 * and affiliate through its account, an order through its affiliate, a lead
 * through its optional account. The BP07 scopePredicate receives those
 * expressions and adds its own IS NOT NULL guards, so a NULL never widens
 * anything: an instance whose entity carries no affiliate simply does not
 * match an affiliate branch.
 *
 * INTERNAL NEVER REACHES AN EXTERNAL REPRESENTATION.
 * `externalSlaForEntity` selects `p.sla_type = 'EXTERNAL'` in SQL and maps
 * to a shape with no accountable user, no team, no rule internals. The
 * portal phase reads that function and nothing else here.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { resolveScope, scopePredicate, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { parseDuration } from '../sla/calendar.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function audit(
  ctx: WriteContext,
  eventType: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType,
    entityId,
    action: 'CONFIGURE',
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

// ---- Monitor -----------------------------------------------------------------

export interface SlaMonitorRow {
  slaInstanceId: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  customerName: string | null;
  ruleName: string;
  slaType: string;
  status: string;
  startedAt: string;
  targetAt: string;
  warningAt: string | null;
  stoppedAt: string | null;
  breachedAt: string | null;
  pausedMinutes: number;
  accountableUserName: string | null;
  accountableTeamName: string | null;
}

const MONITOR_SELECT = `
  SELECT i.sla_instance_id, i.entity_type, i.entity_id, i.status, i.started_at, i.target_at,
         i.warning_at, i.stopped_at, i.breached_at, i.paused_minutes,
         r.rule_name, p.sla_type,
         au.display_name AS accountable_user_name, tm.team_name AS accountable_team_name,
         COALESCE(sc.subject, l.title, so.document_number, po.document_number) AS entity_label,
         COALESCE(a_case.account_name, a_lead.account_name, a_so.account_name) AS customer_name
  FROM sla_instances i
  JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
  JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
  LEFT JOIN users au ON au.user_id = i.accountable_user_id
  LEFT JOIN teams tm ON tm.team_id = i.accountable_team_id
  LEFT JOIN service_cases sc ON i.entity_type = 'CASE' AND sc.case_id = i.entity_id
  LEFT JOIN accounts a_case ON a_case.account_id = sc.account_id
  LEFT JOIN leads l ON i.entity_type = 'LEAD' AND l.lead_id = i.entity_id
  LEFT JOIN accounts a_lead ON a_lead.account_id = l.account_id
  LEFT JOIN sales_orders so ON i.entity_type = 'SALES_ORDER' AND so.sales_order_id = i.entity_id
  LEFT JOIN accounts a_so ON a_so.account_id = so.account_id
  LEFT JOIN affiliates af_so ON af_so.affiliate_id = so.affiliate_id
  LEFT JOIN purchase_orders po ON i.entity_type = 'PURCHASE_ORDER' AND po.purchase_order_id = i.entity_id
  LEFT JOIN affiliates af_po ON af_po.affiliate_id = po.affiliate_id`;

/** The scope columns, as COALESCE across whichever entity the instance measures. */
const MONITOR_COLUMNS = {
  country: `COALESCE(a_case.country_id, a_lead.country_id, a_so.country_id, af_so.country_id, af_po.country_id)`,
  affiliate: `COALESCE(a_case.affiliate_id, a_lead.affiliate_id, a_so.affiliate_id, so.affiliate_id, po.affiliate_id)`,
  businessUnit: `COALESCE(sc.business_unit_id, l.business_unit_id, so.business_unit_id, po.business_unit_id)`,
  team: 'i.accountable_team_id',
  owner: 'i.accountable_user_id',
} as const;

export async function scopedSlaInstances(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, 'SLA.DASHBOARD.VIEW');
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, MONITOR_COLUMNS);
}

export interface SlaMonitorQuery {
  readonly slaType: string | null;
  readonly entityType: string | null;
  readonly status: string | null;
  readonly bucket: 'at-risk' | 'breached' | 'active' | 'completed' | null;
  readonly page: number;
}

export async function listSlaInstances(
  db: Client,
  userId: string,
  query: SlaMonitorQuery,
  now: Date,
): Promise<{ items: SlaMonitorRow[]; total: number; page: number; pageSize: number }> {
  const scope = await scopedSlaInstances(db, userId);
  const clauses: string[] = [scope.sql];
  const args: unknown[] = [...scope.args];
  if (query.slaType !== null) {
    clauses.push('p.sla_type = ?');
    args.push(query.slaType);
  }
  if (query.entityType !== null) {
    clauses.push('i.entity_type = ?');
    args.push(query.entityType);
  }
  if (query.status !== null) {
    clauses.push('i.status = ?');
    args.push(query.status);
  }
  const stamp = toDbTimestamp(now);
  switch (query.bucket) {
    case 'at-risk':
      clauses.push(`i.status = 'RUNNING' AND i.warning_at IS NOT NULL AND i.warning_at <= ?`);
      args.push(stamp);
      break;
    case 'breached':
      clauses.push(`i.status = 'BREACHED'`);
      break;
    case 'active':
      clauses.push(`i.status IN ('RUNNING','PAUSED')`);
      break;
    case 'completed':
      clauses.push(`i.status IN ('MET','BREACHED','CANCELLED') AND i.stopped_at IS NOT NULL`);
      break;
    case null:
      break;
  }
  const where = clauses.join(' AND ');
  const pageSize = 25;
  const [counted, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM (${MONITOR_SELECT} WHERE ${where})`,
      args: args as never[],
    }),
    db.execute({
      sql: `${MONITOR_SELECT} WHERE ${where}
            ORDER BY i.target_at LIMIT ? OFFSET ?`,
      args: [...args, pageSize, (query.page - 1) * pageSize] as never[],
    }),
  ]);
  return {
    items: rows.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        slaInstanceId: text(row.sla_instance_id),
        entityType: text(row.entity_type),
        entityId: text(row.entity_id),
        entityLabel: nullableText(row.entity_label),
        customerName: nullableText(row.customer_name),
        ruleName: text(row.rule_name),
        slaType: text(row.sla_type),
        status: text(row.status),
        startedAt: text(row.started_at),
        targetAt: text(row.target_at),
        warningAt: nullableText(row.warning_at),
        stoppedAt: nullableText(row.stopped_at),
        breachedAt: nullableText(row.breached_at),
        pausedMinutes: Number(row.paused_minutes ?? 0),
        accountableUserName: nullableText(row.accountable_user_name),
        accountableTeamName: nullableText(row.accountable_team_name),
      };
    }),
    total: Number(counted.rows[0]?.n ?? 0),
    page: query.page,
    pageSize,
  };
}

/**
 * The external SLA facts for one entity, portal-safe by construction: the
 * INTERNAL filter is `p.sla_type = 'EXTERNAL'` in the SQL, and the shape has
 * nowhere to put an accountable person even by accident.
 */
export interface ExternalSlaRow {
  status: string;
  targetAt: string;
  stoppedAt: string | null;
}

export async function externalSlaForEntity(
  db: Client,
  entityType: string,
  entityId: string,
): Promise<ExternalSlaRow[]> {
  const result = await db.execute({
    sql: `SELECT i.status, i.target_at, i.stopped_at
          FROM sla_instances i
          JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
          JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
          WHERE i.entity_type = ? AND i.entity_id = ? AND p.sla_type = 'EXTERNAL'
          ORDER BY i.started_at`,
    args: [entityType, entityId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      status: text(row.status),
      targetAt: text(row.target_at),
      stoppedAt: nullableText(row.stopped_at),
    };
  });
}

// ---- Configuration reads -----------------------------------------------------

export interface CalendarRow {
  businessCalendarId: string;
  calendarName: string;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  days: boolean[];
  active: boolean;
  holidays: { holidayId: string; holidayDate: string; holidayName: string }[];
}

export async function listCalendars(db: Client): Promise<CalendarRow[]> {
  const [calendars, holidays] = await db.batch(
    [
      `SELECT business_calendar_id, calendar_name, timezone, workday_start, workday_end,
              monday, tuesday, wednesday, thursday, friday, saturday, sunday, active
       FROM business_calendars ORDER BY calendar_name`,
      `SELECT holiday_id, business_calendar_id, holiday_date, holiday_name
       FROM holidays ORDER BY holiday_date`,
    ],
    'read',
  );
  const byCalendar = new Map<string, CalendarRow['holidays']>();
  for (const raw of holidays.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.business_calendar_id);
    const list = byCalendar.get(id) ?? [];
    list.push({
      holidayId: text(row.holiday_id),
      holidayDate: text(row.holiday_date),
      holidayName: text(row.holiday_name),
    });
    byCalendar.set(id, list);
  }
  return calendars.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      businessCalendarId: text(row.business_calendar_id),
      calendarName: text(row.calendar_name),
      timezone: text(row.timezone),
      workdayStart: text(row.workday_start),
      workdayEnd: text(row.workday_end),
      days: [
        Number(row.monday) === 1,
        Number(row.tuesday) === 1,
        Number(row.wednesday) === 1,
        Number(row.thursday) === 1,
        Number(row.friday) === 1,
        Number(row.saturday) === 1,
        Number(row.sunday) === 1,
      ],
      active: Number(row.active) === 1,
      holidays: byCalendar.get(text(row.business_calendar_id)) ?? [],
    };
  });
}

export async function addHoliday(
  db: Client,
  calendarId: string,
  holidayDate: string,
  holidayName: string,
  ctx: WriteContext,
): Promise<WriteResult<CalendarRow[]>> {
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO holidays (holiday_id, business_calendar_id, holiday_date, holiday_name)
                VALUES (?, ?, ?, ?)`,
          args: [newId('HOL'), calendarId, holidayDate, holidayName],
        },
        audit(ctx, 'CALENDAR_UPDATED', 'BUSINESS_CALENDAR', calendarId, null, {
          holidayDate,
          holidayName,
        }),
      ],
      'write',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          { field: 'holidayDate', message: 'That date is already a holiday on this calendar.' },
        ],
      };
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return { ok: false, kind: 'not_found' };
    }
    throw error;
  }
  return { ok: true, value: await listCalendars(db) };
}

export interface ProfileRow {
  slaProfileId: string;
  profileName: string;
  slaType: string;
  precedenceLevel: number;
  accountId: string | null;
  accountName: string | null;
  segment: string | null;
  affiliateId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  ruleCount: number;
}

export async function listProfiles(db: Client): Promise<ProfileRow[]> {
  const result = await db.execute(
    `SELECT p.sla_profile_id, p.profile_name, p.sla_type, p.precedence_level, p.account_id,
            a.account_name, p.segment, p.affiliate_id, p.effective_from, p.effective_to, p.active,
            (SELECT COUNT(*) FROM sla_rules r WHERE r.sla_profile_id = p.sla_profile_id) AS rule_count
     FROM sla_profiles p LEFT JOIN accounts a ON a.account_id = p.account_id
     ORDER BY p.precedence_level DESC, p.profile_name`,
  );
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      slaProfileId: text(row.sla_profile_id),
      profileName: text(row.profile_name),
      slaType: text(row.sla_type),
      precedenceLevel: Number(row.precedence_level),
      accountId: nullableText(row.account_id),
      accountName: nullableText(row.account_name),
      segment: nullableText(row.segment),
      affiliateId: nullableText(row.affiliate_id),
      effectiveFrom: text(row.effective_from),
      effectiveTo: nullableText(row.effective_to),
      active: Number(row.active) === 1,
      ruleCount: Number(row.rule_count ?? 0),
    };
  });
}

export interface ProfileInput {
  profileName: string;
  slaType: string;
  precedenceLevel: number;
  accountId: string | null;
  segment: string | null;
  affiliateId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

export async function createProfile(
  db: Client,
  input: ProfileInput,
  ctx: WriteContext,
): Promise<WriteResult<ProfileRow[]>> {
  const id = newId('SLAP');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO sla_profiles
                  (sla_profile_id, profile_name, sla_type, precedence_level, account_id, segment,
                   affiliate_id, effective_from, effective_to, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.profileName,
            input.slaType,
            input.precedenceLevel,
            input.accountId,
            input.segment,
            input.affiliateId,
            input.effectiveFrom,
            input.effectiveTo,
            input.active ? 1 : 0,
          ],
        },
        audit(ctx, 'SLA_PROFILE_CREATED', 'SLA_PROFILE', id, null, input),
      ],
      'write',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'profileName', message: 'A profile with that name already exists.' }],
      };
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'accountId', message: 'That account or affiliate does not exist.' }],
      };
    }
    throw error;
  }
  return { ok: true, value: await listProfiles(db) };
}

export async function updateProfile(
  db: Client,
  id: string,
  input: ProfileInput,
  ctx: WriteContext,
): Promise<WriteResult<ProfileRow[]>> {
  const before = (await listProfiles(db)).find((p) => p.slaProfileId === id);
  if (before === undefined) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE sla_profiles SET profile_name = ?, sla_type = ?, precedence_level = ?,
                  account_id = ?, segment = ?, affiliate_id = ?, effective_from = ?,
                  effective_to = ?, active = ?
                WHERE sla_profile_id = ?`,
          args: [
            input.profileName,
            input.slaType,
            input.precedenceLevel,
            input.accountId,
            input.segment,
            input.affiliateId,
            input.effectiveFrom,
            input.effectiveTo,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(ctx, 'SLA_PROFILE_UPDATED', 'SLA_PROFILE', id, before, input),
      ],
      'write',
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'profileName', message: 'A profile with that name already exists.' }],
      };
    }
    throw error;
  }
  return { ok: true, value: await listProfiles(db) };
}

export interface RuleRow {
  slaRuleId: string;
  slaProfileId: string;
  profileName: string;
  ruleName: string;
  entityType: string;
  stageCode: string | null;
  priority: string | null;
  targetMinutes: number;
  warningMinutes: number | null;
  businessCalendarId: string;
  calendarName: string;
  businessHoursOnly: boolean;
  pauseAllowed: boolean;
  escalationAfterMinutes: number | null;
  active: boolean;
  instanceCount: number;
}

export async function listRules(db: Client): Promise<RuleRow[]> {
  const result = await db.execute(
    `SELECT r.sla_rule_id, r.sla_profile_id, p.profile_name, r.rule_name, r.entity_type,
            r.stage_code, r.priority, r.target_minutes, r.warning_minutes,
            r.business_calendar_id, c.calendar_name, r.business_hours_only, r.pause_allowed,
            r.escalation_after_minutes, r.active,
            (SELECT COUNT(*) FROM sla_instances i WHERE i.sla_rule_id = r.sla_rule_id) AS instance_count
     FROM sla_rules r
     JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
     JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
     ORDER BY p.precedence_level DESC, r.rule_name`,
  );
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      slaRuleId: text(row.sla_rule_id),
      slaProfileId: text(row.sla_profile_id),
      profileName: text(row.profile_name),
      ruleName: text(row.rule_name),
      entityType: text(row.entity_type),
      stageCode: nullableText(row.stage_code),
      priority: nullableText(row.priority),
      targetMinutes: Number(row.target_minutes),
      warningMinutes: nullableNumber(row.warning_minutes),
      businessCalendarId: text(row.business_calendar_id),
      calendarName: text(row.calendar_name),
      businessHoursOnly: Number(row.business_hours_only) === 1,
      pauseAllowed: Number(row.pause_allowed) === 1,
      escalationAfterMinutes: nullableNumber(row.escalation_after_minutes),
      active: Number(row.active) === 1,
      instanceCount: Number(row.instance_count ?? 0),
    };
  });
}

export interface RuleInput {
  slaProfileId: string;
  ruleName: string;
  entityType: string;
  stageCode: string | null;
  priority: string | null;
  /** As typed: "30 minutes", "2 hours", "1 business day". Converted here. */
  target: string;
  warning: string | null;
  businessCalendarId: string;
  businessHoursOnly: boolean;
  pauseAllowed: boolean;
  escalationAfter: string | null;
  active: boolean;
}

/**
 * Convert the typed durations against the rule's own calendar, so "1
 * business day" means that calendar's working window, and refuse anything
 * unreadable rather than guessing.
 */
async function resolveDurations(
  db: Client,
  input: RuleInput,
): Promise<
  | {
      ok: true;
      targetMinutes: number;
      warningMinutes: number | null;
      escalationMinutes: number | null;
    }
  | { ok: false; fields: FieldError[] }
> {
  const calendar = await db.execute({
    sql: `SELECT workday_start, workday_end FROM business_calendars WHERE business_calendar_id = ?`,
    args: [input.businessCalendarId],
  });
  const row = calendar.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return { ok: false, fields: [{ field: 'businessCalendarId', message: 'Choose a calendar.' }] };
  }
  const [sh, sm] = text(row.workday_start).split(':').map(Number);
  const [eh, em] = text(row.workday_end).split(':').map(Number);
  const workdayMinutes = (eh ?? 0) * 60 + (em ?? 0) - ((sh ?? 0) * 60 + (sm ?? 0));

  const targetMinutes = parseDuration(input.target, workdayMinutes);
  if (targetMinutes === null || targetMinutes <= 0) {
    return {
      ok: false,
      fields: [
        {
          field: 'target',
          message: 'Enter a duration such as "30 minutes", "2 hours" or "1 business day".',
        },
      ],
    };
  }
  const warningMinutes =
    input.warning === null ? null : parseDuration(input.warning, workdayMinutes);
  if (input.warning !== null && warningMinutes === null) {
    return {
      ok: false,
      fields: [{ field: 'warning', message: 'Enter a readable duration, or leave it empty.' }],
    };
  }
  const escalationMinutes =
    input.escalationAfter === null ? null : parseDuration(input.escalationAfter, workdayMinutes);
  if (input.escalationAfter !== null && escalationMinutes === null) {
    return {
      ok: false,
      fields: [
        { field: 'escalationAfter', message: 'Enter a readable duration, or leave it empty.' },
      ],
    };
  }
  return { ok: true, targetMinutes, warningMinutes, escalationMinutes };
}

export async function createRule(
  db: Client,
  input: RuleInput,
  ctx: WriteContext,
): Promise<WriteResult<RuleRow[]>> {
  const durations = await resolveDurations(db, input);
  if (!durations.ok) return { ok: false, kind: 'invalid_reference', fields: durations.fields };
  const id = newId('SLAR');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO sla_rules
                  (sla_rule_id, sla_profile_id, rule_name, entity_type, stage_code, priority,
                   target_minutes, warning_minutes, business_calendar_id, business_hours_only,
                   pause_allowed, escalation_after_minutes, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.slaProfileId,
            input.ruleName,
            input.entityType,
            input.stageCode,
            input.priority,
            durations.targetMinutes,
            durations.warningMinutes,
            input.businessCalendarId,
            input.businessHoursOnly ? 1 : 0,
            input.pauseAllowed ? 1 : 0,
            durations.escalationMinutes,
            input.active ? 1 : 0,
          ],
        },
        audit(ctx, 'SLA_RULE_CREATED', 'SLA_RULE', id, null, {
          ...input,
          targetMinutes: durations.targetMinutes,
          warningMinutes: durations.warningMinutes,
        }),
      ],
      'write',
    );
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'slaProfileId', message: 'That profile or calendar does not exist.' }],
      };
    }
    throw error;
  }
  return { ok: true, value: await listRules(db) };
}

export async function updateRule(
  db: Client,
  id: string,
  input: RuleInput,
  ctx: WriteContext,
): Promise<WriteResult<RuleRow[]>> {
  const before = (await listRules(db)).find((r) => r.slaRuleId === id);
  if (before === undefined) return { ok: false, kind: 'not_found' };
  const durations = await resolveDurations(db, input);
  if (!durations.ok) return { ok: false, kind: 'invalid_reference', fields: durations.fields };
  await db.batch(
    [
      {
        sql: `UPDATE sla_rules SET sla_profile_id = ?, rule_name = ?, entity_type = ?,
                stage_code = ?, priority = ?, target_minutes = ?, warning_minutes = ?,
                business_calendar_id = ?, business_hours_only = ?, pause_allowed = ?,
                escalation_after_minutes = ?, active = ?
              WHERE sla_rule_id = ?`,
        args: [
          input.slaProfileId,
          input.ruleName,
          input.entityType,
          input.stageCode,
          input.priority,
          durations.targetMinutes,
          durations.warningMinutes,
          input.businessCalendarId,
          input.businessHoursOnly ? 1 : 0,
          input.pauseAllowed ? 1 : 0,
          durations.escalationMinutes,
          input.active ? 1 : 0,
          id,
        ],
      },
      audit(ctx, 'SLA_RULE_UPDATED', 'SLA_RULE', id, before, {
        ...input,
        targetMinutes: durations.targetMinutes,
        warningMinutes: durations.warningMinutes,
      }),
    ],
    'write',
  );
  return { ok: true, value: await listRules(db) };
}
