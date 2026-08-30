/**
 * The SLA runtime engine.
 *
 * EVERYTHING RUNS FROM EVENTS AND PERSISTED TIMESTAMPS. NOTHING TICKS.
 * A Cloudflare Worker has no always-on process, so there is no timer here at
 * all. Starting an SLA computes and persists `target_at` and `warning_at`
 * through the business calendar; finding due instances is then one indexed
 * query over (status, target_at), run by `sweepDueSlas` whenever the engine
 * is entered: the SLA monitor render, and every domain-event handler. An SLA
 * that breaches while nothing is running is found on the next entry, and its
 * `breached_at` is the true `target_at`, not the moment of detection: the
 * record says when the promise broke, not when somebody noticed.
 *
 * THE REAL SHAPES, NOT THE IMAGINED ONES.
 * The running status is RUNNING (an insert with ACTIVE fails the CHECK). The
 * paused column is `paused_minutes`. There is no measured column: measured
 * time is derived from started_at, stopped_at and paused_minutes. The pause
 * reason lives on the PAUSE row of `sla_timer_events`. `target_at` is NOT
 * NULL and is computed at start.
 *
 * PAUSE MOVES THE TARGET, NEVER THE START.
 * `started_at` is immutable. Pausing inserts a PAUSE event; resuming inserts
 * RESUME, accumulates the paused interval into `paused_minutes`, and pushes
 * `target_at` and `warning_at` forward by the same interval, measured the
 * way the rule measures (business or wall minutes). That keeps the one
 * indexed due query truthful without any per-instance arithmetic at read
 * time. No time historically spent in a status is ever subtracted without a
 * timer event as evidence.
 *
 * A BREACHED SLA NEVER BECOMES MET. Completion after a breach sets
 * stopped_at and leaves the status BREACHED. The work being eventually done
 * does not unbreak the promise.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import {
  addBusinessMinutes,
  addWallMinutes,
  businessMinutesBetween,
  wallMinutesBetween,
  type CalendarSpec,
} from './calendar.ts';

type Stmt = Extract<InStatement, { sql: string }>;

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/** "YYYY-MM-DD HH:MM:SS" stored UTC, to a Date. */
export const fromDb = (stamp: string): Date => new Date(`${stamp.replace(' ', 'T')}Z`);

// ---- Table verification -----------------------------------------------------

/**
 * The operator's prerequisite script added sla_breaches and
 * sla_escalation_events. The batch instructions state it has been run; this
 * verifies it with a query wherever the engine actually runs, and the engine
 * refuses to start without them rather than failing later mid-write.
 */
export async function verifySlaTables(db: Client): Promise<{ ok: boolean; missing: string[] }> {
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE name IN ('sla_breaches','sla_escalation_events')`,
  );
  const present = new Set(result.rows.map((r) => String((r as Record<string, unknown>).name)));
  const missing = ['sla_breaches', 'sla_escalation_events'].filter((t) => !present.has(t));
  return { ok: missing.length === 0, missing };
}

// ---- Rule resolution --------------------------------------------------------

export interface SlaRuleContext {
  entityType: 'LEAD' | 'OPPORTUNITY' | 'CASE' | 'SALES_ORDER' | 'PURCHASE_ORDER' | 'WORKFLOW_STAGE';
  entityId: string;
  accountId: string | null;
  segment: string | null;
  affiliateId: string | null;
  priority: string | null;
  stageCode: string | null;
  at: Date;
}

export interface ResolvedRule {
  slaRuleId: string;
  ruleName: string;
  slaProfileId: string;
  profileName: string;
  slaType: 'INTERNAL' | 'EXTERNAL';
  precedenceLevel: number;
  targetMinutes: number;
  warningMinutes: number | null;
  businessHoursOnly: boolean;
  pauseAllowed: boolean;
  escalationAfterMinutes: number | null;
  calendar: CalendarSpec;
  businessCalendarId: string;
  /** Why this rule, in a sentence a person can read. */
  explanation: string;
}

async function loadCalendar(db: Client, calendarId: string): Promise<CalendarSpec | null> {
  const [calendars, holidays] = await Promise.all([
    db.execute({
      sql: `SELECT timezone, workday_start, workday_end, monday, tuesday, wednesday, thursday,
                   friday, saturday, sunday
            FROM business_calendars WHERE business_calendar_id = ? AND active = 1`,
      args: [calendarId],
    }),
    db.execute({
      sql: `SELECT holiday_date FROM holidays WHERE business_calendar_id = ?`,
      args: [calendarId],
    }),
  ]);
  const row = calendars.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
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
    holidays: new Set(
      holidays.rows.map((r) => String((r as Record<string, unknown>).holiday_date)),
    ),
  };
}

/**
 * THE precedence resolution, centralised. Nothing else reads
 * `precedence_level` or ranks specificity.
 *
 * Candidate profiles are active, inside their effective window, and match the
 * context: a profile naming an account matches only that account; naming a
 * segment, only that segment; naming an affiliate, only that affiliate; and
 * one naming none of the three is the general default. The winner is the
 * highest `precedence_level`; a tie falls to the more specific match
 * (customer, then segment, then affiliate, then default), so the seeded
 * customer-specific profile at 100 beats the Key Account segment at 80,
 * which beats the affiliate at 60, which beats the general default.
 *
 * If no rule matches, no timer is invented: the answer is null and the
 * caller creates nothing.
 */
export async function resolveSlaRule(
  db: Client,
  context: SlaRuleContext,
): Promise<ResolvedRule | null> {
  const at = toDbTimestamp(context.at);
  const result = await db.execute({
    sql: `SELECT r.sla_rule_id, r.rule_name, r.target_minutes, r.warning_minutes,
                 r.business_hours_only, r.pause_allowed, r.escalation_after_minutes,
                 r.business_calendar_id, r.stage_code, r.priority,
                 p.sla_profile_id, p.profile_name, p.sla_type, p.precedence_level,
                 p.account_id, p.segment, p.affiliate_id
          FROM sla_rules r
          JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
          WHERE r.active = 1 AND p.active = 1
            AND p.effective_from <= ?
            AND (p.effective_to IS NULL OR p.effective_to >= ?)
            AND r.entity_type = ?
            AND (r.stage_code IS NULL OR r.stage_code = ?)
            AND (r.priority IS NULL OR r.priority = ?)
            AND (p.account_id IS NULL OR p.account_id = ?)
            AND (p.segment IS NULL OR p.segment = ?)
            AND (p.affiliate_id IS NULL OR p.affiliate_id = ?)`,
    args: [
      at,
      at,
      context.entityType,
      context.stageCode,
      context.priority,
      context.accountId,
      context.segment,
      context.affiliateId,
    ] as never[],
  });

  if (result.rows.length === 0) return null;

  const specificity = (row: Record<string, unknown>): number => {
    if (row.account_id !== null) return 3;
    if (row.segment !== null) return 2;
    if (row.affiliate_id !== null) return 1;
    return 0;
  };
  const ranked = [...(result.rows as unknown as Record<string, unknown>[])].sort((a, b) => {
    const precedence = Number(b.precedence_level) - Number(a.precedence_level);
    if (precedence !== 0) return precedence;
    const specific = specificity(b) - specificity(a);
    if (specific !== 0) return specific;
    // A rule naming the stage or priority beats a wildcard at equal rank.
    const aExact = (a.stage_code !== null ? 1 : 0) + (a.priority !== null ? 1 : 0);
    const bExact = (b.stage_code !== null ? 1 : 0) + (b.priority !== null ? 1 : 0);
    if (bExact !== aExact) return bExact - aExact;
    return String(a.sla_rule_id).localeCompare(String(b.sla_rule_id));
  });
  const winner = ranked[0];
  if (winner === undefined) return null;

  const calendar = await loadCalendar(db, text(winner.business_calendar_id));
  if (calendar === null) return null;

  const matched =
    winner.account_id !== null
      ? `customer-specific profile for this account`
      : winner.segment !== null
        ? `segment profile for ${text(winner.segment)}`
        : winner.affiliate_id !== null
          ? `affiliate profile`
          : `general default profile`;
  return {
    slaRuleId: text(winner.sla_rule_id),
    ruleName: text(winner.rule_name),
    slaProfileId: text(winner.sla_profile_id),
    profileName: text(winner.profile_name),
    slaType: text(winner.sla_type) as 'INTERNAL' | 'EXTERNAL',
    precedenceLevel: Number(winner.precedence_level),
    targetMinutes: Number(winner.target_minutes),
    warningMinutes:
      winner.warning_minutes === null || winner.warning_minutes === undefined
        ? null
        : Number(winner.warning_minutes),
    businessHoursOnly: Number(winner.business_hours_only) === 1,
    pauseAllowed: Number(winner.pause_allowed) === 1,
    escalationAfterMinutes:
      winner.escalation_after_minutes === null || winner.escalation_after_minutes === undefined
        ? null
        : Number(winner.escalation_after_minutes),
    calendar,
    businessCalendarId: text(winner.business_calendar_id),
    explanation: `${text(winner.rule_name)} from ${text(winner.profile_name)} (precedence ${Number(winner.precedence_level)}, ${matched}).`,
  };
}

// ---- Start, pause, resume, stop --------------------------------------------

export interface StartSlaInput {
  rule: ResolvedRule;
  entityType: string;
  entityId: string;
  workflowStageInstanceId: string | null;
  accountableUserId: string | null;
  accountableTeamId: string | null;
  startedAt: Date;
  actorUserId: string | null;
}

/**
 * Start one instance, idempotently. The repeat key is (sla_rule_id,
 * entity_type, entity_id) with any non-CANCELLED instance: a duplicate
 * domain event finds the existing instance and creates nothing, and a
 * finished instance is not restarted, because the lifecycle it measured has
 * already been measured.
 */
export async function startSla(db: Client, input: StartSlaInput): Promise<string | null> {
  const existing = await db.execute({
    sql: `SELECT sla_instance_id FROM sla_instances
          WHERE sla_rule_id = ? AND entity_type = ? AND entity_id = ?
            AND status <> 'CANCELLED' LIMIT 1`,
    args: [input.rule.slaRuleId, input.entityType, input.entityId],
  });
  if (existing.rows[0] !== undefined) return null;

  const add = input.rule.businessHoursOnly
    ? (from: Date, minutes: number) => addBusinessMinutes(input.rule.calendar, from, minutes)
    : addWallMinutes;
  const targetAt = add(input.startedAt, input.rule.targetMinutes);
  const warningAt =
    input.rule.warningMinutes === null
      ? null
      : add(input.startedAt, Math.max(0, input.rule.targetMinutes - input.rule.warningMinutes));

  const instanceId = newId('SLAI');
  await db.batch(
    [
      {
        sql: `INSERT INTO sla_instances
                (sla_instance_id, sla_rule_id, entity_type, entity_id,
                 workflow_stage_instance_id, accountable_user_id, accountable_team_id,
                 started_at, target_at, warning_at, stopped_at, paused_minutes, status, breached_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'RUNNING', NULL)`,
        args: [
          instanceId,
          input.rule.slaRuleId,
          input.entityType,
          input.entityId,
          input.workflowStageInstanceId,
          input.accountableUserId,
          input.accountableTeamId,
          toDbTimestamp(input.startedAt),
          toDbTimestamp(targetAt),
          warningAt === null ? null : toDbTimestamp(warningAt),
        ],
      },
      {
        sql: `INSERT INTO sla_timer_events
                (sla_timer_event_id, sla_instance_id, event_type, event_at, reason, actor_user_id)
              VALUES (?, ?, 'START', ?, ?, ?)`,
        args: [
          newId('SLATE'),
          instanceId,
          toDbTimestamp(input.startedAt),
          input.rule.explanation,
          input.actorUserId,
        ],
      },
    ],
    'write',
  );
  return instanceId;
}

interface InstanceRow {
  slaInstanceId: string;
  slaRuleId: string;
  status: string;
  startedAt: string;
  targetAt: string;
  warningAt: string | null;
  pausedMinutes: number;
  accountableUserId: string | null;
  accountableTeamId: string | null;
  workflowStageInstanceId: string | null;
  entityType: string;
  entityId: string;
}

async function loadInstance(db: Client, instanceId: string): Promise<InstanceRow | null> {
  const result = await db.execute({
    sql: `SELECT sla_instance_id, sla_rule_id, status, started_at, target_at, warning_at,
                 paused_minutes, accountable_user_id, accountable_team_id,
                 workflow_stage_instance_id, entity_type, entity_id
          FROM sla_instances WHERE sla_instance_id = ? LIMIT 1`,
    args: [instanceId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    slaInstanceId: text(row.sla_instance_id),
    slaRuleId: text(row.sla_rule_id),
    status: text(row.status),
    startedAt: text(row.started_at),
    targetAt: text(row.target_at),
    warningAt: nullableText(row.warning_at),
    pausedMinutes: Number(row.paused_minutes ?? 0),
    accountableUserId: nullableText(row.accountable_user_id),
    accountableTeamId: nullableText(row.accountable_team_id),
    workflowStageInstanceId: nullableText(row.workflow_stage_instance_id),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
  };
}

async function loadRuleForInstance(
  db: Client,
  slaRuleId: string,
): Promise<{
  businessHoursOnly: boolean;
  pauseAllowed: boolean;
  calendar: CalendarSpec;
} | null> {
  const result = await db.execute({
    sql: `SELECT business_hours_only, pause_allowed, business_calendar_id
          FROM sla_rules WHERE sla_rule_id = ? LIMIT 1`,
    args: [slaRuleId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const calendar = await loadCalendar(db, text(row.business_calendar_id));
  if (calendar === null) return null;
  return {
    businessHoursOnly: Number(row.business_hours_only) === 1,
    pauseAllowed: Number(row.pause_allowed) === 1,
    calendar,
  };
}

/** Pause a RUNNING instance, where the rule allows pausing at all. */
export async function pauseSla(
  db: Client,
  instanceId: string,
  reason: string,
  at: Date,
  actorUserId: string | null,
): Promise<boolean> {
  const instance = await loadInstance(db, instanceId);
  if (instance === null || instance.status !== 'RUNNING') return false;
  const rule = await loadRuleForInstance(db, instance.slaRuleId);
  if (rule === null || !rule.pauseAllowed) return false;
  await db.batch(
    [
      {
        sql: `UPDATE sla_instances SET status = 'PAUSED' WHERE sla_instance_id = ? AND status = 'RUNNING'`,
        args: [instanceId],
      },
      {
        sql: `INSERT INTO sla_timer_events
                (sla_timer_event_id, sla_instance_id, event_type, event_at, reason, actor_user_id)
              VALUES (?, ?, 'PAUSE', ?, ?, ?)`,
        args: [newId('SLATE'), instanceId, toDbTimestamp(at), reason, actorUserId],
      },
    ],
    'write',
  );
  return true;
}

/**
 * Resume a PAUSED instance: accumulate the paused interval into
 * paused_minutes and push target_at and warning_at forward by it, measured
 * the way the rule measures. started_at is never touched.
 */
export async function resumeSla(
  db: Client,
  instanceId: string,
  reason: string,
  at: Date,
  actorUserId: string | null,
): Promise<boolean> {
  const instance = await loadInstance(db, instanceId);
  if (instance === null || instance.status !== 'PAUSED') return false;
  const rule = await loadRuleForInstance(db, instance.slaRuleId);
  if (rule === null) return false;

  const lastPause = await db.execute({
    sql: `SELECT event_at FROM sla_timer_events
          WHERE sla_instance_id = ? AND event_type = 'PAUSE'
          ORDER BY event_at DESC LIMIT 1`,
    args: [instanceId],
  });
  const pausedFrom = lastPause.rows[0]?.event_at;
  if (pausedFrom === undefined) return false;

  const measure = rule.businessHoursOnly
    ? (from: Date, to: Date) => businessMinutesBetween(rule.calendar, from, to)
    : wallMinutesBetween;
  const pausedInterval = measure(fromDb(String(pausedFrom)), at);
  const shift = rule.businessHoursOnly
    ? (from: Date, minutes: number) => addBusinessMinutes(rule.calendar, from, minutes)
    : addWallMinutes;
  const newTarget = shift(fromDb(instance.targetAt), pausedInterval);
  const newWarning =
    instance.warningAt === null ? null : shift(fromDb(instance.warningAt), pausedInterval);

  await db.batch(
    [
      {
        sql: `UPDATE sla_instances
              SET status = 'RUNNING', paused_minutes = paused_minutes + ?, target_at = ?, warning_at = ?
              WHERE sla_instance_id = ? AND status = 'PAUSED'`,
        args: [
          pausedInterval,
          toDbTimestamp(newTarget),
          newWarning === null ? null : toDbTimestamp(newWarning),
          instanceId,
        ],
      },
      {
        sql: `INSERT INTO sla_timer_events
                (sla_timer_event_id, sla_instance_id, event_type, event_at, reason, actor_user_id)
              VALUES (?, ?, 'RESUME', ?, ?, ?)`,
        args: [newId('SLATE'), instanceId, toDbTimestamp(at), reason, actorUserId],
      },
    ],
    'write',
  );
  return true;
}

/**
 * Stop the open instance for a rule kind on an entity: the work happened.
 * Within target the status becomes MET; past it the breach machinery has
 * fired or fires now, and the status stays BREACHED, because a promise that
 * broke stays broken however well the ending went.
 */
export async function stopSla(
  db: Client,
  filter: { entityType: string; entityId: string; stageCode?: string | null },
  at: Date,
  reason: string,
  actorUserId: string | null,
): Promise<string[]> {
  const rows = await db.execute({
    // Open instances, and breached ones the work has not yet finished on: a
    // breach does not end the measurement, completion does, and a completed
    // breach keeps its BREACHED status with stopped_at finally set.
    sql: `SELECT i.sla_instance_id FROM sla_instances i
          JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
          WHERE i.entity_type = ? AND i.entity_id = ?
            AND (i.status IN ('RUNNING','PAUSED')
                 OR (i.status = 'BREACHED' AND i.stopped_at IS NULL))
            ${filter.stageCode === undefined ? '' : 'AND r.stage_code = ?'}`,
    args:
      filter.stageCode === undefined
        ? [filter.entityType, filter.entityId]
        : ([filter.entityType, filter.entityId, filter.stageCode] as never[]),
  });
  const stopped: string[] = [];
  for (const raw of rows.rows) {
    const instanceId = String((raw as Record<string, unknown>).sla_instance_id);
    const instance = await loadInstance(db, instanceId);
    if (instance === null) continue;
    const breached = at > fromDb(instance.targetAt);
    const statements: Stmt[] = [
      {
        sql: `UPDATE sla_instances SET stopped_at = ?, status = ?, breached_at = COALESCE(breached_at, ?)
              WHERE sla_instance_id = ?`,
        args: [
          toDbTimestamp(at),
          breached ? 'BREACHED' : 'MET',
          breached ? instance.targetAt : null,
          instanceId,
        ],
      },
      {
        sql: `INSERT INTO sla_timer_events
                (sla_timer_event_id, sla_instance_id, event_type, event_at, reason, actor_user_id)
              VALUES (?, ?, 'STOP', ?, ?, ?)`,
        args: [newId('SLATE'), instanceId, toDbTimestamp(at), reason, actorUserId],
      },
    ];
    if (breached) {
      // The breach row may already exist from the sweep; INSERT OR IGNORE and
      // the UNIQUE constraint make one primary row the invariant, not a hope.
      statements.push(breachRowStmt(instance, at));
    }
    await db.batch(statements, 'write');
    stopped.push(instanceId);
  }
  return stopped;
}

function breachRowStmt(instance: InstanceRow, detectedAt: Date): Stmt {
  return {
    sql: `INSERT OR IGNORE INTO sla_breaches
            (sla_breach_id, sla_instance_id, entity_type, entity_id, breached_at, target_at,
             breach_minutes, accountable_user_id, accountable_team_id,
             workflow_stage_instance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('SLAB'),
      instance.slaInstanceId,
      instance.entityType,
      instance.entityId,
      instance.targetAt,
      instance.targetAt,
      Math.max(0, wallMinutesBetween(fromDb(instance.targetAt), detectedAt)),
      instance.accountableUserId,
      instance.accountableTeamId,
      instance.workflowStageInstanceId,
      toDbTimestamp(detectedAt),
    ],
  };
}

// ---- The sweep ---------------------------------------------------------------

export interface SweepResult {
  warningsFired: number;
  breachesRecorded: number;
}

/**
 * Find due instances with two indexed queries and settle them. Warning fires
 * once: the guard is a NOT EXISTS on a prior WARNING event, so repeated
 * sweeps re-fire nothing. Breach sets the status, stamps breached_at with
 * the true target time, and inserts the one primary sla_breaches row, where
 * the UNIQUE constraint is the guarantee and a conflict is handled by
 * INSERT OR IGNORE rather than crashed on.
 *
 * Notification creation is phase 16's; the WARNING timer event is the fact
 * it will consume.
 */
export async function sweepDueSlas(db: Client, now: Date): Promise<SweepResult> {
  const stamp = toDbTimestamp(now);

  const warnings = await db.execute({
    sql: `SELECT sla_instance_id FROM sla_instances i
          WHERE i.status = 'RUNNING' AND i.warning_at IS NOT NULL AND i.warning_at <= ?
            AND NOT EXISTS (SELECT 1 FROM sla_timer_events e
                            WHERE e.sla_instance_id = i.sla_instance_id
                              AND e.event_type = 'WARNING')`,
    args: [stamp],
  });
  for (const raw of warnings.rows) {
    const instanceId = String((raw as Record<string, unknown>).sla_instance_id);
    await db.execute({
      sql: `INSERT INTO sla_timer_events
              (sla_timer_event_id, sla_instance_id, event_type, event_at, reason, actor_user_id)
            SELECT ?, ?, 'WARNING', ?, 'Remaining time at or below the warning threshold', NULL
            WHERE NOT EXISTS (SELECT 1 FROM sla_timer_events
                              WHERE sla_instance_id = ? AND event_type = 'WARNING')`,
      args: [newId('SLATE'), instanceId, stamp, instanceId],
    });
  }

  const due = await db.execute({
    sql: `SELECT sla_instance_id FROM sla_instances
          WHERE status = 'RUNNING' AND target_at <= ?`,
    args: [stamp],
  });
  let breaches = 0;
  for (const raw of due.rows) {
    const instanceId = String((raw as Record<string, unknown>).sla_instance_id);
    const instance = await loadInstance(db, instanceId);
    if (instance === null) continue;
    await db.batch(
      [
        {
          // breached_at is the true target, not the detection time.
          sql: `UPDATE sla_instances SET status = 'BREACHED', breached_at = target_at
                WHERE sla_instance_id = ? AND status = 'RUNNING'`,
          args: [instanceId],
        },
        {
          sql: `INSERT INTO sla_timer_events
                  (sla_timer_event_id, sla_instance_id, event_type, event_at, reason, actor_user_id)
                SELECT ?, ?, 'BREACH', ?, 'Target passed', NULL
                WHERE NOT EXISTS (SELECT 1 FROM sla_timer_events
                                  WHERE sla_instance_id = ? AND event_type = 'BREACH')`,
          args: [newId('SLATE'), instanceId, instance.targetAt, instanceId],
        },
        breachRowStmt(instance, now),
      ],
      'write',
    );
    breaches += 1;
  }
  return { warningsFired: warnings.rows.length, breachesRecorded: breaches };
}

// ---- Measurement -------------------------------------------------------------

/**
 * The two durations, derived, never stored: elapsed is wall clock, which is
 * what the customer experienced; accountable is the rule's own measure
 * (business or wall minutes) minus paused_minutes, which is what the SLA
 * judged. They are different numbers with different names, and every caller
 * gets both.
 */
export async function measureInstance(
  db: Client,
  instanceId: string,
  now: Date,
): Promise<{ elapsedMinutes: number; accountableMinutes: number } | null> {
  const instance = await loadInstance(db, instanceId);
  if (instance === null) return null;
  const rule = await loadRuleForInstance(db, instance.slaRuleId);
  if (rule === null) return null;
  const end =
    instance.status === 'MET' || instance.status === 'BREACHED' || instance.status === 'CANCELLED'
      ? await (async () => {
          const stopped = await db.execute({
            sql: `SELECT stopped_at FROM sla_instances WHERE sla_instance_id = ?`,
            args: [instanceId],
          });
          const value = stopped.rows[0]?.stopped_at;
          return value === null || value === undefined ? now : fromDb(String(value));
        })()
      : now;
  const started = fromDb(instance.startedAt);
  const gross = rule.businessHoursOnly
    ? businessMinutesBetween(rule.calendar, started, end)
    : wallMinutesBetween(started, end);
  return {
    elapsedMinutes: wallMinutesBetween(started, end),
    accountableMinutes: Math.max(0, gross - instance.pausedMinutes),
  };
}
