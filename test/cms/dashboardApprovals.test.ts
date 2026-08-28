/**
 * The dashboard's SLA section, cut by approval function.
 *
 * The rules these tests hold are the ones a redesign quietly breaks:
 *
 * THE FUNCTIONS COME FROM THE SCHEMA. A level nobody used has no bar; a level
 * somebody adds appears without a line of code changing. A hard-coded list of
 * four would pass a happy-path render and fail the day the workflow grew, so
 * the test adds a stage at runtime and asserts the chart grew with it.
 *
 * THE AFFILIATE IS A FILTER AND NOT AN AXIS. Purchase orders have no affiliate
 * in the extract at all, and sales orders carry one today and several
 * tomorrow. Narrowing to one must change the figures and never the rows.
 *
 * NOBODY IS BLENDED. A person who approves at two functions has two rows, and
 * neither of them is the average of both.
 *
 * A RANK IS WITHIN A FUNCTION. Ranking a credit approver against an invoicing
 * clerk is a league table between different jobs.
 *
 * A TARGET IS THAT FUNCTION'S OWN, AND ONLY WHERE ONE IS CONFIGURED. Two
 * countries holding a function to different targets do not have a target.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { withApprovalWork } from './support/approvalWork.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { approvals, alignBuckets } from '../../src/lib/cms/dashboard/approvals.ts';
import { forgetResolvedScopes } from '../../src/lib/cms/auth/rbac.ts';

const NOW = '2026-08-27 10:00:00';
const BOTH = { salesOrders: true, purchaseOrders: true };
const filter = parseFilter(new URLSearchParams());
const asClient = (c: TestClient) => c as unknown as Parameters<typeof approvals>[0];

/**
 * Durations are julianday arithmetic, which is a float: thirty minutes comes
 * back as 30.000000223517418. Every assertion below rounds to the minute,
 * which is the resolution the interface shows anyway.
 */
const minutes = (value: number | null): number | null =>
  value === null ? null : Math.round(value);

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await withApprovalWork(c);
  forgetResolvedScopes(c as never);
  return c;
};

const named = (view: Awaited<ReturnType<typeof approvals>>, code: string) =>
  view.functions.find((one) => one.stageCode === code);

test('the approval functions are read from the workflow, not from a list', async () => {
  const c = await db();
  const before = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  const codes = before.functions.map((one) => one.stageCode).sort();
  assert.deepEqual(codes, [
    'CREDIT_CHECK',
    'FINANCE_APPROVAL',
    'PO_LEVEL_1',
    'PO_LEVEL_2',
  ]);

  // A fourth purchase order level, added the way a configuration change adds
  // one: a stage row and instances that used it. No code changes.
  await c.execute(`INSERT INTO workflow_stages VALUES
    ('WST-T1','WFD-002','PO_LEVEL_GROUP','Group Finance Approval',4,'WORKFLOW_ROLE',NULL,'WROLE-GFIN',NULL,'ANY_ONE',1,NULL,0)`);
  await c.execute(`INSERT INTO workflow_stage_instances VALUES
    ('WSI-T10','WFI-T4','WST-T1','USR-GCFO',NULL,'APPROVED','2026-08-24 12:00:00','2026-08-24 12:00:00','2026-08-24 13:00:00','Approved')`);
  forgetResolvedScopes(c as never);

  const after = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.ok(
    after.functions.some((one) => one.stageCode === 'PO_LEVEL_GROUP'),
    'a level somebody added did not appear, so the axis is hard-coded somewhere',
  );
  assert.equal(after.functions.length, before.functions.length + 1);
});

test('a level nobody used has no bar at all', async () => {
  const c = await db();
  // Configured, never walked through.
  await c.execute(`INSERT INTO workflow_stages VALUES
    ('WST-T2','WFD-002','PO_LEVEL_UNUSED','Unused Level',5,'TEAM',NULL,NULL,'TEAM-FIN-KE','ANY_ONE',1,NULL,0)`);
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.equal(
    view.functions.some((one) => one.stageCode === 'PO_LEVEL_UNUSED'),
    false,
    'an empty bar is worse than no bar',
  );
});

test('the third stage is a function too, once somebody uses it', async () => {
  const c = await db();
  // WST-003 is the sales order Loading / Invoice stage: seeded, and nothing in
  // the fixture has passed through it, so it is absent until something does.
  const before = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.equal(named(before, 'LOADING'), undefined);
  await c.execute(`INSERT INTO workflow_stage_instances VALUES
    ('WSI-T11','WFI-T1','WST-003','USR-AMN','TEAM-OPS-KE','COMPLETED','2026-08-25 10:10:00','2026-08-25 10:10:00','2026-08-25 10:30:00','Loaded')`);
  forgetResolvedScopes(c as never);
  const after = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.equal(minutes(named(after, 'LOADING')?.medianMinutes ?? null), 20);
});

test('the affiliate narrows the figures and is the axis of nothing', async () => {
  const c = await db();
  const all = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  forgetResolvedScopes(c as never);
  const uganda = await approvals(
    asClient(c),
    SEED.admin,
    { ...filter, affiliateId: SEED.affUganda },
    NOW,
    BOTH,
  );
  // Every row is still keyed on a stage code, never on an affiliate.
  for (const one of all.functions) {
    assert.match(one.stageCode, /^[A-Z0-9_]+$/);
  }
  assert.equal(
    all.functions.some((one) => /hass petroleum/i.test(one.functionName)),
    false,
    'an affiliate name reached a function label, so it has become an axis',
  );
  // All the fixture work is Kenyan, so narrowing to Uganda empties the figures
  // rather than adding a row per affiliate.
  assert.ok(all.functions.length > 0);
  assert.equal(uganda.functions.length, 0);
});

test('there is no business unit cut anywhere in the view', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.equal(
    /businessUnit/i.test(JSON.stringify(view)),
    false,
    'neither extract carries a business unit worth charting, so nothing may claim one',
  );
});

test('a person who approves at two functions appears once under each, never blended', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  const gabriel = view.groups
    .flatMap((one) => one.rows.map((row) => ({ group: one, row })))
    .filter((entry) => entry.row.userId === SEED.gabriel);

  assert.equal(gabriel.length, 2, 'one row per function, and exactly one');
  assert.deepEqual(
    [...new Set(gabriel.map((entry) => entry.group.stageCode))].sort(),
    ['FINANCE_APPROVAL', 'PO_LEVEL_2'],
  );

  const finance = gabriel.find((entry) => entry.group.stageCode === 'FINANCE_APPROVAL');
  const purchase = gabriel.find((entry) => entry.group.stageCode === 'PO_LEVEL_2');
  // Four sales order finance approvals (the seed's own 42 minutes and three
  // fixture ones at 30), against two purchase order approvals at 140 and 170.
  // A blend across all six would be neither answer.
  assert.equal(minutes(finance?.row.medianMinutes ?? null), 30);
  assert.equal(finance?.row.transactions, 4);
  // 140 and 170: the median convention this codebase uses throughout takes the
  // lower of the two middle values rather than interpolating between them.
  assert.equal(minutes(purchase?.row.medianMinutes ?? null), 140);
  assert.equal(purchase?.row.transactions, 2);
});

test('the rank is awarded within the function, not down the whole list', async () => {
  const c = await db();
  const view = await approvals(
    asClient(c),
    SEED.admin,
    { ...filter, minVolume: 1 },
    NOW,
    { salesOrders: true, purchaseOrders: true },
  );
  const ranked = view.groups.filter((one) => one.rows.some((row) => row.rank === 1));
  assert.ok(ranked.length > 1, 'only one function had a first place, so the rank is global');
  for (const one of view.groups) {
    const ranks = one.rows.filter((row) => row.rank !== null).map((row) => row.rank);
    assert.deepEqual(
      [...ranks].sort((a, b) => (a ?? 0) - (b ?? 0)),
      ranks.length === 0 ? [] : Array.from({ length: ranks.length }, (_, i) => i + 1),
      'ranks within a function are not 1..n',
    );
  }
});

test('below the minimum volume a person keeps their figures and loses only the rank', async () => {
  const c = await db();
  // The default minimum is ten and nobody in the fixture is near it.
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  const rows = view.groups.flatMap((one) => one.rows);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.rankEligible, false);
    assert.equal(row.rank, null);
  }
  const gabriel = rows.find(
    (row) => row.userId === SEED.gabriel && minutes(row.medianMinutes) === 30,
  );
  assert.ok(gabriel, 'a person below the minimum was dropped instead of unranked');
  assert.equal(gabriel?.transactions, 4);
});

test('a target belongs to its own function and is absent where none is configured', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  // SLAR-003 holds finance approval to sixty minutes; the credit stage has its
  // own rule at a different number.
  assert.equal(named(view, 'FINANCE_APPROVAL')?.targetMinutes, 60);
  assert.notEqual(
    named(view, 'CREDIT_CHECK')?.targetMinutes,
    named(view, 'FINANCE_APPROVAL')?.targetMinutes,
  );
});

test('two definitions that disagree about a target do not have one', async () => {
  const c = await db();
  const before = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.equal(named(before, 'FINANCE_APPROVAL')?.targetMinutes, 60);

  // A second country's sales order workflow, holding the same function to a
  // different number, and an order that used it.
  await c.execute(`INSERT INTO sla_rules VALUES
    ('SLAR-T1','SLAP-004','SO finance approval, Uganda','SALES_ORDER','FINANCE_APPROVAL',NULL,240,180,'CAL-KE',1,0,240,1)`);
  await c.execute(`INSERT INTO workflow_definitions VALUES
    ('WFD-T1','Uganda Sales Order Approval','SALES_ORDER','CTR-KE','AFF-KE',NULL,1,1,'2026-01-01',NULL)`);
  await c.execute(`INSERT INTO workflow_stages VALUES
    ('WST-T3','WFD-T1','FINANCE_APPROVAL','Finance Approval',1,'WORKFLOW_ROLE',NULL,'WROLE-SO-FIN',NULL,'ANY_ONE',1,'SLAR-T1',0)`);
  await c.execute(`INSERT INTO workflow_instances VALUES
    ('WFI-T6','WFD-T1','SALES_ORDER','SO-002','IN_PROGRESS','2026-08-25 08:30:00',NULL,'WST-T3',CURRENT_TIMESTAMP)`);
  await c.execute(`INSERT INTO workflow_stage_instances VALUES
    ('WSI-T12','WFI-T6','WST-T3','USR-FMUG',NULL,'APPROVED','2026-08-25 08:30:00','2026-08-25 08:30:00','2026-08-25 09:00:00','Approved')`);
  forgetResolvedScopes(c as never);

  const after = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.equal(
    named(after, 'FINANCE_APPROVAL')?.targetMinutes,
    null,
    'one of two disagreeing targets was drawn as if it were agreed',
  );
});

test('stage one by product group counts an order once in each group it touches', async () => {
  const c = await db();
  // PO-004 already carries one LPG line. A lubricants line is added so the
  // order genuinely spans two groups.
  await c.execute(`INSERT INTO purchase_order_lines VALUES
    ('POL-T1','PO-004',2,'PROD-LUBE',100,50,5000)`);
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  const byName = new Map(view.stageOneByProductGroup.map((row) => [row.productGroupName, row]));

  // PO-001 is fuels, stage one 120 minutes. PO-004 is LPG and lubricants,
  // stage one 60 minutes, and appears in both at the same figure.
  assert.equal(minutes(byName.get('Ground Fuels')?.medianMinutes ?? null), 120);
  assert.equal(minutes(byName.get('LPG')?.medianMinutes ?? null), 60);
  assert.equal(minutes(byName.get('Lubricants')?.medianMinutes ?? null), 60);
  assert.equal(byName.get('LPG')?.orders, 1);
  assert.equal(byName.get('Lubricants')?.orders, 1);
});

test('stage one is measured from submission, never from the order being created', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  const fuels = view.stageOneByProductGroup.find(
    (row) => row.productGroupName === 'Ground Fuels',
  );
  // PO-001 was created at 07:30 and submitted at 07:40; stage one completed at
  // 09:40. From submission that is 120 minutes, from creation it would be 130.
  assert.equal(minutes(fuels?.medianMinutes ?? null), 120);
});

test('the credit release list is the credit function, by the person who released it', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  assert.ok(view.creditRelease.length > 0);
  for (const row of view.creditRelease) {
    assert.equal(row.stageCode, 'CREDIT_CHECK');
    assert.equal(row.processType, 'SALES_ORDER');
  }
  const victor = view.creditRelease.find((row) => row.userId === SEED.victor);
  assert.equal(minutes(victor?.medianMinutes ?? null), 40, 'the 09:30 to 10:10 release');
  assert.equal(victor?.pending, 2, 'the two credit decisions still open are still his');
});

test('a period with no completed cycles is a gap in the line, never a zero', () => {
  const aligned = alignBuckets(
    [
      { bucket: '2026-08-24', medianMinutes: 30 },
      { bucket: '2026-08-26', medianMinutes: 45 },
    ],
    [{ bucket: '2026-08-25', medianMinutes: 120 }],
  );
  assert.deepEqual(aligned.buckets, ['2026-08-24', '2026-08-25', '2026-08-26']);
  assert.deepEqual(aligned.first, [30, null, 45]);
  assert.deepEqual(aligned.second, [null, 120, null]);
});

test('the pending count and the oldest pending item survive to the chart', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  const credit = named(view, 'CREDIT_CHECK');
  assert.ok(credit, 'the credit function is missing');
  assert.ok((credit?.pending ?? 0) > 0, 'work still open was reported as none');
  assert.equal(typeof credit?.oldestPendingAt, 'string');
});

/**
 * Two defects the SLA section found in code it reads from, kept fixed here
 * because this is the section that noticed them.
 */

test('a trend median is not lost to the rows that have no value', async () => {
  const c = await db();
  const view = await approvals(asClient(c), SEED.admin, filter, NOW, BOTH);
  // Three of the five purchase orders were never submitted for approval, so
  // three of the five cycle values are missing. The median is the median of
  // the two that exist, and the row number that finds it counts only those:
  // ranking with nulls first pointed it at a missing row and reported the
  // whole period as having no figure.
  assert.equal(view.purchaseTrend.length, 1);
  assert.equal(
    minutes(view.purchaseTrend[0]?.medianMinutes ?? null),
    230,
    'a period with figures in it reported none',
  );
});

test('a duration axis is wide enough for its own labels', async () => {
  const { lineChart } = await import('../../src/lib/cms/charts/svg.ts');
  const { formatDuration } = await import('../../src/lib/cms/analytics/stats.ts');
  const chart = lineChart(
    [
      {
        name: 'Cycle',
        token: 'cms-series-1',
        points: [
          { label: '2026-07', value: 200 },
          { label: '2026-08', value: 500 },
        ],
      },
    ],
    { unit: 'minutes', format: formatDuration },
  );
  // The axis labels are right-anchored, so the widest one starts at x minus its
  // own width. At the old fixed inset of 56 that was a negative number and the
  // reader was shown "h 20 min" with the hours cut off the left edge.
  const anchors = [...chart.svg.matchAll(/<text x="(\d+)" [^>]*text-anchor="end"/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(anchors.length > 0, 'the value axis has no labels');
  const widest = Math.max(...chart.table.rows.map((row) => row[1]?.length ?? 0));
  for (const x of anchors) {
    assert.ok(
      x >= widest * 6.2,
      `an axis label anchored at ${x} cannot fit ${widest} characters to its left`,
    );
  }
});
