/**
 * Phase 15: the SLA runtime engine.
 *
 * Everything here drives the engine the way production does: domain events
 * in, persisted timestamps out, and a sweep whenever the engine is entered.
 * The business-calendar cases run first because everything downstream
 * depends on them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  fromLocal,
  toLocal,
  parseDuration,
} from '../../src/lib/cms/sla/calendar.ts';
import {
  verifySlaTables,
  resolveSlaRule,
  sweepDueSlas,
  measureInstance,
} from '../../src/lib/cms/sla/engine.ts';
import {
  registerSlaHandlers,
  resetSlaRegistration,
  startWorkflowStageSla,
  stopWorkflowStageSla,
  CASE_PAUSE_POLICY,
} from '../../src/lib/cms/sla/wiring.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';
import {
  createCase,
  changeCaseStatus,
  addCommunication,
} from '../../src/lib/cms/repos/serviceAdmin.ts';
import { createLead, recordFirstContact } from '../../src/lib/cms/repos/leadAdmin.ts';
import {
  listSlaInstances,
  scopedSlaInstances,
  externalSlaForEntity,
} from '../../src/lib/cms/repos/slaAdmin.ts';

const NOW = new Date('2026-08-27T07:00:00Z'); // 10:00 in Nairobi, a Thursday
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const KE = {
  timezone: 'Africa/Nairobi',
  workdayStart: '08:00',
  workdayEnd: '17:00',
  days: [true, true, true, true, true, false, false] as const,
  holidays: new Set<string>(),
};

async function grantAll(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-034','CRM','LEADS','MANAGE','Manage leads'),
          ('PERM-039','SERVICE','CASES','MANAGE','Manage cases')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-034','PERM-039')`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantAll(c);
  // Fresh event wiring per database, since handlers are process-global.
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  resetSlaRegistration();
  registerSlaHandlers();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof resolveSlaRule>[0];

// ---------------------------------------------------------------------------
// The business calendar. Nothing below is trustworthy until these pass.
// ---------------------------------------------------------------------------

test('friday 16:00 plus four business hours lands monday 11:00, not saturday', () => {
  const start = fromLocal(2026, 8, 28, 16, 0, KE.timezone); // Friday
  const due = addBusinessMinutes(KE, start, 240);
  const local = toLocal(due, KE.timezone);
  assert.deepEqual([local.date, local.hour, local.minute], ['2026-08-31', 11, 0]);
});

test('a weekend rollover and a holiday inside the window both push the target', () => {
  const overWeekend = addBusinessMinutes(KE, fromLocal(2026, 8, 28, 16, 30, KE.timezone), 60);
  assert.equal(toLocal(overWeekend, KE.timezone).date, '2026-08-31');

  const withHoliday = { ...KE, holidays: new Set(['2026-08-31']) };
  const due = addBusinessMinutes(
    withHoliday,
    fromLocal(2026, 8, 28, 16, 0, withHoliday.timezone),
    240,
  );
  assert.deepEqual(
    [toLocal(due, KE.timezone).date, toLocal(due, KE.timezone).hour],
    ['2026-09-01', 11],
  );
});

test('a start outside business hours counts from opening, and the measure agrees with the walk', () => {
  const early = addBusinessMinutes(KE, fromLocal(2026, 8, 26, 6, 30, KE.timezone), 60);
  assert.equal(toLocal(early, KE.timezone).hour, 9);
  const from = fromLocal(2026, 8, 28, 16, 0, KE.timezone);
  const to = fromLocal(2026, 8, 31, 11, 0, KE.timezone);
  assert.equal(businessMinutesBetween(KE, from, to), 240);
});

test('a daylight-saving zone finds the wall time on both sides of the change', () => {
  const before = fromLocal(2026, 3, 28, 12, 0, 'Europe/London');
  const after = fromLocal(2026, 3, 30, 12, 0, 'Europe/London');
  assert.equal(toLocal(before, 'Europe/London').hour, 12);
  assert.equal(toLocal(after, 'Europe/London').hour, 12);
  assert.equal((after.getTime() - before.getTime()) / 3600000, 47);
});

test('admins type durations, the system stores minutes', () => {
  assert.equal(parseDuration('30 minutes', 540), 30);
  assert.equal(parseDuration('2 hours', 540), 120);
  assert.equal(parseDuration('1 business day', 540), 540);
  assert.equal(parseDuration('24 hours', 540), 1440);
  assert.equal(parseDuration('gibberish', 540), null);
});

// ---------------------------------------------------------------------------
// Prerequisites and the real shapes.
// ---------------------------------------------------------------------------

test('the prerequisite tables are verified with a query, and an ACTIVE status is refused by the CHECK', async () => {
  const c = await db();
  const verified = await verifySlaTables(asClient(c));
  assert.deepEqual(verified, { ok: true, missing: [] });

  await assert.rejects(
    c.execute({
      sql: `INSERT INTO sla_instances (sla_instance_id, sla_rule_id, entity_type, entity_id,
              started_at, target_at, paused_minutes, status)
            VALUES ('SLAI-X','SLAR-001','CASE','CASE-001','2026-08-27 07:00:00','2026-08-27 08:00:00',0,'ACTIVE')`,
      args: [],
    }),
    /CHECK constraint failed/,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Precedence.
// ---------------------------------------------------------------------------

test('customer-specific beats segment beats affiliate beats default, through one resolver', async () => {
  const c = await db();
  const base = {
    entityType: 'CASE' as const,
    entityId: 'X',
    priority: 'HIGH',
    stageCode: 'FIRST_RESPONSE',
    at: NOW,
  };
  // ACC-001 is BluePeak: the customer contract profile at precedence 100.
  const customer = await resolveSlaRule(asClient(c), {
    ...base,
    accountId: 'ACC-001',
    segment: 'Key Account',
    affiliateId: 'AFF-KE',
  });
  assert.equal(customer?.slaRuleId, 'SLAR-006');
  assert.match(customer?.explanation ?? '', /customer-specific/);

  // A Key Account customer that is not BluePeak: the segment profile at 80.
  const segment = await resolveSlaRule(asClient(c), {
    ...base,
    accountId: 'ACC-004',
    segment: 'Key Account',
    affiliateId: 'AFF-KE',
  });
  assert.equal(segment?.slaRuleId, 'SLAR-001');
  // SLAR-001 sits on the Group External profile; the segment profile has no
  // FIRST_RESPONSE rule of its own in the seed, so the general rule wins and
  // the explanation says which profile provided it.
  assert.equal(segment?.profileName, 'Group External Standard');

  // No rule at all: no timer is invented.
  const none = await resolveSlaRule(asClient(c), {
    ...base,
    stageCode: 'NO_SUCH_STAGE',
    accountId: null,
    segment: null,
    affiliateId: null,
  });
  assert.equal(none, null);
  c.close();
});

// ---------------------------------------------------------------------------
// The lifecycle, driven by real domain events.
// ---------------------------------------------------------------------------

const caseInput = (over: Record<string, unknown> = {}) =>
  ({
    accountId: 'ACC-004',
    contactId: 'CON-004',
    businessUnitId: 'BU-CI',
    caseType: 'COMPLAINT',
    caseCategoryId: 'CC-001',
    priority: 'HIGH',
    subject: 'SLA lifecycle case',
    description: 'Raised to drive the SLA engine in a test',
    channel: 'EMAIL',
    raisedAt: '2026-08-27 07:00:00',
    assignedTeamId: 'TEAM-CS-KE',
    assignedUserId: 'USR-CATH',
    ...over,
  }) as never;

test('a case first-response SLA starts from the event, is stopped by the qualifying outbound, and is MET within target', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const instances = await c.execute({
    sql: `SELECT i.sla_instance_id, i.status, i.started_at, i.target_at, r.stage_code
          FROM sla_instances i JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
          WHERE i.entity_type = 'CASE' AND i.entity_id = ?`,
    args: [made.value.caseId],
  });
  // One first-response instance; no resolution rule exists in the seed, so no
  // second instance was invented.
  assert.equal(instances.rows.length, 1);
  const instance = instances.rows[0] as Record<string, unknown>;
  assert.equal(String(instance.stage_code), 'FIRST_RESPONSE');
  assert.equal(String(instance.status), 'RUNNING');
  // The clock started when the customer raised it: 07:00 UTC, 10:00 local.
  assert.equal(String(instance.started_at), '2026-08-27 07:00:00');
  // 60 business minutes later inside a working Thursday: 11:00 local,
  // 08:00 UTC.
  assert.equal(String(instance.target_at), '2026-08-27 08:00:00');

  // The duplicate event creates no second instance.
  const { emitCaseEvent } = await import('../../src/lib/cms/service/events.ts');
  await emitCaseEvent(asClient(c), {
    type: 'CASE_CREATED',
    caseId: made.value.caseId,
    at: NOW,
    actorUserId: SEED.admin,
    detail: {},
  });
  const again = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sla_instances WHERE entity_type = 'CASE' AND entity_id = ?`,
    args: [made.value.caseId],
  });
  assert.equal(Number(again.rows[0]?.n), 1);

  // The qualifying outbound stops it, MET, with a STOP event.
  await addCommunication(
    asClient(c),
    SEED.admin,
    made.value.caseId,
    {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      contactId: null,
      subject: null,
      messageSummary: 'Answered inside the hour',
      communicatedAt: '2026-08-27 07:40:00',
    },
    { ...CTX, now: new Date('2026-08-27T07:40:00Z') },
  );
  const stopped = await c.execute({
    sql: `SELECT status, stopped_at FROM sla_instances WHERE sla_instance_id = ?`,
    args: [String(instance.sla_instance_id)],
  });
  assert.equal(String(stopped.rows[0]?.status), 'MET');
  assert.notEqual(stopped.rows[0]?.stopped_at, null);
  c.close();
});

test('warning fires exactly once under repeated sweeps, breach writes exactly one primary row, and completion stays BREACHED', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const instanceRow = await c.execute({
    sql: `SELECT sla_instance_id, target_at FROM sla_instances WHERE entity_type = 'CASE' AND entity_id = ?`,
    args: [made.value.caseId],
  });
  const instanceId = String(instanceRow.rows[0]?.sla_instance_id);
  const targetAt = String(instanceRow.rows[0]?.target_at);

  // Past the warning threshold, repeatedly.
  const nearTarget = new Date('2026-08-27T07:50:00Z');
  await sweepDueSlas(asClient(c), nearTarget);
  await sweepDueSlas(asClient(c), nearTarget);
  await sweepDueSlas(asClient(c), nearTarget);
  const warnings = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sla_timer_events WHERE sla_instance_id = ? AND event_type = 'WARNING'`,
    args: [instanceId],
  });
  assert.equal(Number(warnings.rows[0]?.n), 1);

  // Past the target: BREACHED, breached_at is the true target, one breach row.
  const afterTarget = new Date('2026-08-27T09:00:00Z');
  await sweepDueSlas(asClient(c), afterTarget);
  await sweepDueSlas(asClient(c), afterTarget);
  const breached = await c.execute({
    sql: `SELECT status, breached_at FROM sla_instances WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(String(breached.rows[0]?.status), 'BREACHED');
  assert.equal(String(breached.rows[0]?.breached_at), targetAt);
  const breachRows = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sla_breaches WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(Number(breachRows.rows[0]?.n), 1);

  // A second insert against the UNIQUE constraint is refused by the database.
  await assert.rejects(
    c.execute({
      sql: `INSERT INTO sla_breaches (sla_breach_id, sla_instance_id, entity_type, entity_id, breached_at, target_at)
            VALUES ('SLAB-DUP', ?, 'CASE', ?, ?, ?)`,
      args: [instanceId, made.value.caseId, targetAt, targetAt],
    }),
    /UNIQUE constraint failed/,
  );

  // The work finally happens. The SLA stays BREACHED; it never becomes MET.
  await addCommunication(
    asClient(c),
    SEED.admin,
    made.value.caseId,
    {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      contactId: null,
      subject: null,
      messageSummary: 'Late answer',
      communicatedAt: '2026-08-27 12:00:00',
    },
    { ...CTX, now: new Date('2026-08-27T12:00:00Z') },
  );
  const final = await c.execute({
    sql: `SELECT status, stopped_at FROM sla_instances WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(String(final.rows[0]?.status), 'BREACHED');
  assert.notEqual(final.rows[0]?.stopped_at, null);
  c.close();
});

test('WAITING_CUSTOMER pauses where allowed, WAITING_INTERNAL never pauses, and two pauses accumulate with started_at unchanged', async () => {
  const c = await db();
  assert.equal(CASE_PAUSE_POLICY.WAITING_CUSTOMER, 'pause');
  assert.equal(CASE_PAUSE_POLICY.WAITING_INTERNAL, 'run');

  // The seeded first-response rules have pause_allowed = 0, which is its own
  // fact worth proving: the engine refuses to pause them. Flip the rule for
  // the accumulation half of the test.
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const caseId = made.value.caseId;
  const instanceRow = await c.execute({
    sql: `SELECT sla_instance_id, started_at, target_at FROM sla_instances WHERE entity_type = 'CASE' AND entity_id = ?`,
    args: [caseId],
  });
  const instanceId = String(instanceRow.rows[0]?.sla_instance_id);
  const startedAt = String(instanceRow.rows[0]?.started_at);

  const t = (m: string) => new Date(`2026-08-27T${m}:00Z`);
  const move = (to: string, at: Date) =>
    changeCaseStatus(
      asClient(c),
      SEED.admin,
      caseId,
      { toStatus: to as never, reason: null, resolutionSummary: null, rootCause: null },
      { ...CTX, now: at },
    );

  await move('IN_PROGRESS', t('07:05'));
  // Rule forbids pausing: the wait is recorded, the clock keeps running.
  await move('WAITING_CUSTOMER', t('07:10'));
  let status = await c.execute({
    sql: `SELECT status FROM sla_instances WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(String(status.rows[0]?.status), 'RUNNING');

  // Allow pausing and go around again: pause, resume, pause, resume.
  await c.execute({ sql: `UPDATE sla_rules SET pause_allowed = 1`, args: [] });
  await move('IN_PROGRESS', t('07:12'));
  await move('WAITING_CUSTOMER', t('07:15'));
  status = await c.execute({
    sql: `SELECT status FROM sla_instances WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(String(status.rows[0]?.status), 'PAUSED');
  await move('IN_PROGRESS', t('07:25')); // 10 minutes paused
  await move('WAITING_CUSTOMER', t('07:30'));
  await move('IN_PROGRESS', t('07:45')); // 15 more

  const after = await c.execute({
    sql: `SELECT status, started_at, paused_minutes FROM sla_instances WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(String(after.rows[0]?.status), 'RUNNING');
  assert.equal(Number(after.rows[0]?.paused_minutes), 25);
  // Never modify started_at.
  assert.equal(String(after.rows[0]?.started_at), startedAt);

  // WAITING_INTERNAL pauses nothing even with pausing allowed.
  await move('WAITING_INTERNAL', t('07:50'));
  status = await c.execute({
    sql: `SELECT status FROM sla_instances WHERE sla_instance_id = ?`,
    args: [instanceId],
  });
  assert.equal(String(status.rows[0]?.status), 'RUNNING');

  // Elapsed and accountable are two different figures.
  const measured = await measureInstance(asClient(c), instanceId, t('08:00'));
  assert.notEqual(measured, null);
  if (measured !== null) {
    // 07:00 to 08:00 UTC, 10:00 to 11:00 on the Nairobi wall clock.
    assert.equal(measured.elapsedMinutes, 60);
    assert.equal(measured.accountableMinutes, 60 - 25);
  }
  c.close();
});

test('the lead first-contact SLA starts at capture and stops on the recorded contact', async () => {
  const c = await db();
  const lead = await createLead(
    asClient(c),
    {
      accountId: 'ACC-004',
      primaryContactId: null,
      leadSourceId: 'LS-002',
      campaignId: null,
      businessUnitId: 'BU-CI',
      ownerUserId: SEED.james,
      title: 'SLA lead',
      description: null,
      productInterest: null,
      estimatedVolume: null,
      estimatedValue: 100000,
      currencyCode: 'KES',
      capturedAt: '2026-08-27 10:00:00',
    },
    CTX,
  );
  assert.equal(lead.ok, true);
  if (!lead.ok) return;
  const started = await c.execute({
    sql: `SELECT i.sla_instance_id, i.status, r.stage_code FROM sla_instances i
          JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
          WHERE i.entity_type = 'LEAD' AND i.entity_id = ?`,
    args: [lead.value.leadId],
  });
  assert.equal(started.rows.length, 1);
  assert.equal(String(started.rows[0]?.stage_code), 'FIRST_CONTACT');

  await recordFirstContact(asClient(c), SEED.admin, lead.value.leadId, {
    ...CTX,
    now: new Date('2026-08-27T07:30:00Z'),
  });
  const stopped = await c.execute({
    sql: `SELECT status FROM sla_instances WHERE sla_instance_id = ?`,
    args: [String(started.rows[0]?.sla_instance_id)],
  });
  assert.equal(String(stopped.rows[0]?.status), 'MET');
  c.close();
});

test('a workflow stage SLA starts and stops through the stage functions', async () => {
  const c = await db();
  const at = new Date('2026-08-27T07:00:00Z');
  await startWorkflowStageSla(asClient(c), {
    entityType: 'SALES_ORDER',
    entityId: 'SO-003',
    stageCode: 'FINANCE_APPROVAL',
    stageInstanceId: 'WSI-001',
    accountableUserId: SEED.gabriel,
    accountableTeamId: 'TEAM-FIN-KE',
    affiliateId: 'AFF-KE',
    at,
    actorUserId: SEED.admin,
  });
  const started = await c.execute({
    sql: `SELECT sla_instance_id, status, workflow_stage_instance_id FROM sla_instances
          WHERE entity_type = 'SALES_ORDER' AND entity_id = 'SO-003'`,
    args: [],
  });
  assert.equal(started.rows.length, 1);
  assert.equal(String(started.rows[0]?.status), 'RUNNING');
  assert.equal(String(started.rows[0]?.workflow_stage_instance_id), 'WSI-001');

  // The duplicate start creates nothing.
  await startWorkflowStageSla(asClient(c), {
    entityType: 'SALES_ORDER',
    entityId: 'SO-003',
    stageCode: 'FINANCE_APPROVAL',
    stageInstanceId: 'WSI-001',
    accountableUserId: SEED.gabriel,
    accountableTeamId: null,
    affiliateId: 'AFF-KE',
    at,
    actorUserId: SEED.admin,
  });
  const counted = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sla_instances WHERE entity_type = 'SALES_ORDER' AND entity_id = 'SO-003'`,
    args: [],
  });
  assert.equal(Number(counted.rows[0]?.n), 1);

  await stopWorkflowStageSla(asClient(c), {
    entityType: 'SALES_ORDER',
    entityId: 'SO-003',
    stageCode: 'FINANCE_APPROVAL',
    at: new Date('2026-08-27T07:30:00Z'),
    actorUserId: SEED.admin,
  });
  const stopped = await c.execute({
    sql: `SELECT status FROM sla_instances WHERE entity_type = 'SALES_ORDER' AND entity_id = 'SO-003'`,
    args: [],
  });
  assert.equal(String(stopped.rows[0]?.status), 'MET');
  c.close();
});

// ---------------------------------------------------------------------------
// The monitor and the external boundary.
// ---------------------------------------------------------------------------

test('the monitor is scope-filtered, and a caller with no dashboard grant sees nothing', async () => {
  const c = await db();
  const admin = await listSlaInstances(
    asClient(c),
    SEED.admin,
    { slaType: null, entityType: null, status: null, bucket: null, page: 1 },
    NOW,
  );
  assert.equal(admin.total >= 5, true); // the five seeded instances

  const outsider = await scopedSlaInstances(asClient(c), SEED.external[0] ?? 'USR-EXT001');
  assert.equal(outsider.sql, '1 = 0');
  const externalList = await listSlaInstances(
    asClient(c),
    SEED.external[0] ?? 'USR-EXT001',
    { slaType: null, entityType: null, status: null, bucket: null, page: 1 },
    NOW,
  );
  assert.equal(externalList.total, 0);
  c.close();
});

test('internal SLAs are absent from the external representation, by SQL and by shape', async () => {
  const c = await db();
  // SLAI-002 measures SO-002 under an INTERNAL profile; nothing external
  // exists for it, so the external view is empty rather than redacted.
  const internalOnly = await externalSlaForEntity(asClient(c), 'SALES_ORDER', 'SO-002');
  assert.equal(internalOnly.length, 0);

  // CASE-002's first-response instance sits under the EXTERNAL profile.
  const external = await externalSlaForEntity(asClient(c), 'CASE', 'CASE-002');
  assert.equal(external.length, 1);
  const serialised = JSON.stringify(external);
  assert.equal(serialised.includes('accountable'), false);
  assert.equal(serialised.includes('INTERNAL'), false);
  assert.deepEqual(Object.keys(external[0] ?? {}).sort(), ['status', 'stoppedAt', 'targetAt']);
  c.close();
});

test('an SLA that breaches while nothing is running is settled on the next entry, at the true target', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  // Nothing runs for six hours. The next engine entry is a sweep.
  const result = await sweepDueSlas(asClient(c), new Date('2026-08-27T13:00:00Z'));
  assert.equal(result.breachesRecorded >= 1, true);
  const row = await c.execute({
    sql: `SELECT status, breached_at, target_at FROM sla_instances WHERE entity_type = 'CASE' AND entity_id = ?`,
    args: [made.value.caseId],
  });
  assert.equal(String(row.rows[0]?.status), 'BREACHED');
  assert.equal(String(row.rows[0]?.breached_at), String(row.rows[0]?.target_at));
  c.close();
});
