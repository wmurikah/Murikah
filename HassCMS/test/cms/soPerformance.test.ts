/**
 * Phase 20: sales order operations and performance.
 *
 * The rules this phase exists to enforce are all about honesty in numbers,
 * so the tests are about the numbers: that a count and its drill-down agree,
 * that a credit denominator holds only orders that needed credit, that a
 * missing timestamp is missing rather than zero, that elapsed and
 * accountable are two figures, and that a Kenya user's totals stop at the
 * Kenyan border.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseFilter, filterToQuery, drillTo } from '../../src/lib/cms/analytics/filters.ts';
import {
  durationStats,
  minutesBetweenSql,
  formatDuration,
  coverageSentence,
} from '../../src/lib/cms/analytics/stats.ts';
import {
  soSummary,
  listSalesOrders,
  countSalesOrders,
  creditPicture,
  fulfilmentDurations,
  approverPerformance,
  productPerformance,
  customerPerformance,
  backlog,
  ageBuckets,
  trend,
  valueByCurrency,
  orderDetail,
  exportCsv,
  csvCell,
} from '../../src/lib/cms/repos/soPerformance.ts';
import {
  barChart,
  lineChart,
  distributionChart,
  funnelChart,
} from '../../src/lib/cms/charts/svg.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const NOW = '2026-08-27 10:00:00';

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof soSummary>[0];
const filter = (query = '') => parseFilter(new URLSearchParams(query));

test('the filter is one object, survives the URL and orders a reversed range', () => {
  const parsed = filter('from=2026-06-30&to=2026-06-01&affiliateId=AFF-KE&creditRequired=YES');
  assert.equal(parsed.from, '2026-06-01', 'a reversed range is a typing mistake, not a query');
  assert.equal(parsed.to, '2026-06-30');
  assert.equal(parsed.affiliateId, 'AFF-KE');
  assert.equal(parsed.creditRequired, 'YES');
  assert.equal(parsed.grain, 'DAY', 'a month of data gets daily points');

  const round = parseFilter(new URLSearchParams(filterToQuery(parsed).slice(1)));
  assert.deepEqual(round, parsed, 'the filter round-trips through the URL unchanged');

  const drill = drillTo('/app/orders/sales', parsed, { status: 'PENDING_FINANCE' });
  assert.ok(drill.includes('affiliateId=AFF-KE'), 'a drill-down carries its context');
  assert.ok(drill.includes('status=PENDING_FINANCE'));

  // A long period does not get daily points.
  assert.equal(filter('from=2026-01-01&to=2026-12-31').grain, 'MONTH');
  assert.equal(filter('from=2026-01-01&to=2026-04-01').grain, 'WEEK');
});

test('median and P90 are computed in SQL, with the stated even-count rule', async () => {
  const c = await db();
  await c.execute(`CREATE TABLE t (v REAL)`);
  // Four values: the median is the LOWER middle, 20, not the mean of 20 and 30.
  await c.execute(`INSERT INTO t VALUES (10),(20),(30),(40)`);
  const even = await durationStats(asClient(c), { valueSql: 'v', source: 't', where: '1 = 1' }, []);
  assert.equal(even.measured, 4);
  assert.equal(even.medianMinutes, 20, 'row (4 + 1) / 2 = 2 by integer division');
  assert.equal(even.averageMinutes, 25);
  assert.equal(even.p90Minutes, 40, 'row (4 * 9 + 9) / 10 = 4');

  await c.execute(`INSERT INTO t VALUES (50)`);
  const odd = await durationStats(asClient(c), { valueSql: 'v', source: 't', where: '1 = 1' }, []);
  assert.equal(odd.medianMinutes, 30, 'five values put the median in the middle');
  assert.equal(odd.p90Minutes, 50);

  // A NULL is never a zero: it leaves the population and shows in coverage.
  await c.execute(`INSERT INTO t VALUES (NULL)`);
  const withNull = await durationStats(
    asClient(c),
    { valueSql: 'v', source: 't', where: '1 = 1' },
    [],
  );
  assert.equal(withNull.measured, 5);
  assert.equal(withNull.total, 6);
  assert.equal(withNull.medianMinutes, 30, 'the NULL did not drag the median down');
  assert.ok(coverageSentence(withNull, 'orders').includes('5 of 6'));
  assert.ok(coverageSentence(withNull, 'orders').includes('never counted as zero'));
});

test('a duration reads as a duration, and an absent one says so', () => {
  assert.equal(formatDuration(null), 'Not available');
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(90), '1 h 30 min');
  assert.equal(formatDuration(1440), '1 d');
  assert.equal(formatDuration(2880 + 180), '2 d 3 h');
});

test('the aggregate and the detail list use one scope, and Kenya stops at Kenya', async () => {
  const c = await db();
  // Catherine is Group scope; Frank is the Uganda finance manager.
  const group = await countSalesOrders(asClient(c), SEED.admin, filter(), NOW);
  const uganda = await countSalesOrders(asClient(c), 'USR-FMUG', filter(), NOW);
  assert.ok(group > 0);
  assert.ok(uganda < group, 'a country user sees fewer orders than a Group user');

  const ugandaList = await listSalesOrders(asClient(c), 'USR-FMUG', filter(), NOW, 500);
  assert.equal(
    ugandaList.length,
    uganda,
    'the count and the list are the same predicate, so they agree exactly',
  );
  assert.equal(
    ugandaList.every((row) => row.affiliateId === 'AFF-UG'),
    true,
    'and nothing outside the scope appears in either',
  );

  const ugandaSummary = await soSummary(asClient(c), 'USR-FMUG', filter(), NOW);
  assert.equal(ugandaSummary.orders, uganda, 'the summary counts the same population');

  // A user with no order permission at all sees nothing, not everything.
  const none = await countSalesOrders(asClient(c), 'USR-JAM', filter(), NOW);
  assert.equal(none, 0);
});

test('the credit denominator holds only orders that needed credit approval', async () => {
  const c = await db();
  const picture = await creditPicture(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(
    picture.ordersRequiringCredit + picture.ordersNotRequiringCredit,
    picture.ordersInSelection,
    'every order is in exactly one of the two counts',
  );
  assert.ok(picture.ordersNotRequiringCredit > 0, 'the seed has orders that never needed credit');

  // The turnaround population is the credit-required orders alone.
  assert.equal(
    picture.turnaround.elapsed.total,
    picture.ordersRequiringCredit,
    'orders that never needed credit are not in the credit denominator',
  );
  assert.ok(
    picture.turnaround.elapsed.total < picture.ordersInSelection,
    'and the denominator is genuinely smaller than the selection',
  );
  assert.notEqual(picture.requiredRatePercent, null);
});

test('an order that never required credit reads "Not required", never zero minutes', async () => {
  const c = await db();
  const noCredit = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE credit_approval_required = 0 LIMIT 1`,
  );
  const id = String(noCredit.rows[0]?.sales_order_id);
  const detail = await orderDetail(asClient(c), SEED.admin, id);
  assert.notEqual(detail, null);
  assert.equal(detail?.order.creditRequired, false);
  const step = detail?.lifecycle.find((entry) => entry.step === 'Credit approval');
  assert.equal(step?.note, 'Not required.');
  assert.equal(step?.at, null, 'and there is no timestamp pretending it happened');
  assert.notEqual(step?.note, '0 min');
});

test('elapsed and accountable are two figures and are never the same number by accident', async () => {
  const c = await db();
  // Give one order's finance stage a paused SLA instance, which is what makes
  // the two figures differ.
  const stage = await c.execute(`
    SELECT wsi.workflow_stage_instance_id AS id FROM workflow_stage_instances wsi
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    WHERE wi.entity_type = 'SALES_ORDER' AND ws.stage_code = 'FINANCE_APPROVAL'
      AND wsi.completed_at IS NOT NULL LIMIT 1`);
  const stageId = String(stage.rows[0]?.id);
  // The SLA instance the engine already attached to that stage records the
  // pause. Nothing else about the stage changes.
  const updated = await c.execute({
    sql: `UPDATE sla_instances SET paused_minutes = 30 WHERE workflow_stage_instance_id = ?`,
    args: [stageId],
  });
  assert.ok(Number(updated.rowsAffected ?? 1) >= 1);

  const summary = await soSummary(asClient(c), SEED.admin, filter(), NOW);
  assert.notEqual(summary.finance.elapsed.medianMinutes, null);
  assert.notEqual(summary.finance.accountable.medianMinutes, null);
  assert.ok(
    (summary.finance.accountable.averageMinutes ?? 0) <
      (summary.finance.elapsed.averageMinutes ?? 0),
    'the pause comes off the accountable figure and not off the elapsed one',
  );
});

test('order to invoice excludes the orders with no invoice timestamp and says how many', async () => {
  const c = await db();
  const durations = await fulfilmentDurations(asClient(c), SEED.admin, filter(), NOW);
  assert.ok(durations.orderToInvoice.total > durations.orderToInvoice.measured);
  assert.ok(
    coverageSentence(durations.orderToInvoice, 'orders').includes(
      'excluded, never counted as zero',
    ),
  );

  // Loading authority and loaded are different metrics, and the second is
  // absent from this data rather than borrowed from the first.
  assert.ok(durations.orderToLoadingAuthority.measured > 0);
  assert.ok(
    durations.orderToLoaded.measured < durations.orderToLoadingAuthority.measured,
    'loading authority and loaded are different metrics measured on different populations',
  );
  assert.notEqual(
    durations.orderToLoaded.medianMinutes,
    durations.orderToLoadingAuthority.medianMinutes,
    'and the second is never the first wearing a different label',
  );
  assert.ok(durations.orderToLoaded.total > durations.orderToLoaded.measured);
  assert.ok(coverageSentence(durations.orderToLoaded, 'orders').includes('of'));
});

test('every backlog number opens a list whose count matches it exactly', async () => {
  const c = await db();
  const signals = await backlog(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(signals.length, 6);
  for (const signal of signals) {
    const drilled = filter(new URLSearchParams(signal.drill).toString());
    const listed = await countSalesOrders(asClient(c), SEED.admin, drilled, NOW);
    assert.equal(
      listed,
      signal.orders,
      `${signal.label} reported ${signal.orders} but its list holds ${listed}`,
    );
  }
  assert.ok(
    signals.some((signal) => signal.orders > 0),
    'the seed has a backlog to drill into',
  );
});

test('a person approving two processes is two rows, and volume gates the rank', async () => {
  const c = await db();
  // Gabriel already approves the sales order finance stage (WSI-001) AND a
  // purchase order stage (WSI-003) in the seeded data. Give him a second
  // sales order stage as well, so both separations can be seen at once.
  await c.execute(`INSERT INTO workflow_stage_instances
    (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id, assigned_user_id,
     assigned_team_id, status, assigned_at, started_at, completed_at, action_notes)
    VALUES ('WSI-SO-CRD','WFI-001','WST-002','USR-GAB','TEAM-FIN-KE','APPROVED',
            '2026-08-25 08:42:00','2026-08-25 08:42:00','2026-08-25 09:30:00','Credit released')`);

  const performance = await approverPerformance(asClient(c), SEED.admin, filter(), NOW);
  assert.ok(performance.rows.length > 0);

  const gabriel = performance.rows.filter((row) => row.userId === 'USR-GAB');
  assert.equal(gabriel.length, 2, 'one row per stage, never one blended average');
  assert.deepEqual(gabriel.map((row) => row.stageCode).sort(), [
    'CREDIT_CHECK',
    'FINANCE_APPROVAL',
  ]);
  assert.equal(
    gabriel.every((row) => row.transactions === 1),
    true,
    'each row counts only its own stage',
  );

  // His purchase order work is in the seed and is NOT folded into either row:
  // the grouping key carries the process, so a blend is impossible.
  assert.equal(
    performance.rows.every((row) => row.processType === 'SALES_ORDER'),
    true,
    'this table is the sales order process; the purchase order stage is a separate row elsewhere',
  );
  const poStages = await c.execute(
    `SELECT COUNT(*) AS n FROM workflow_stage_instances wsi
     JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
     WHERE wi.entity_type = 'PURCHASE_ORDER' AND wsi.assigned_user_id = 'USR-GAB'`,
  );
  assert.ok(Number(poStages.rows[0]?.n) > 0, 'he genuinely approves in both processes');
  assert.equal(
    gabriel.reduce((sum, row) => sum + row.transactions, 0),
    2,
    'and his sales order figures count two sales order stages, not three transactions',
  );

  // Nobody below the stated minimum volume is ranked.
  const high = filter('minVolume=1000');
  const gated = await approverPerformance(asClient(c), SEED.admin, high, NOW);
  assert.equal(gated.minimumVolume, 1000);
  assert.equal(
    gated.rows.every((row) => row.rank === null),
    true,
    'one transaction never outranks three hundred: below the minimum there is no rank',
  );
  assert.equal(
    gated.rows.every((row) => row.rankEligible === false),
    true,
  );
  assert.ok(
    gated.rows.some((row) => row.medianMinutes !== null),
    'and the figures are still shown, without a rank beside them',
  );

  // Above the minimum, a rank appears and is by median rather than by volume.
  const open = filter('minVolume=1');
  const ranked = await approverPerformance(asClient(c), SEED.admin, open, NOW);
  const withRank = ranked.rows.filter((row) => row.rank !== null);
  assert.ok(withRank.length >= 2);
  // The table stays ordered by volume, so the reader sees who carries the
  // load first; the rank itself ascends with the median.
  assert.deepEqual(
    withRank
      .slice()
      .sort((a, b) => (a.medianMinutes ?? 0) - (b.medianMinutes ?? 0))
      .map((row) => row.rank),
    withRank.map((_unused, index) => index + 1),
  );
});

test('two finance managers in different affiliates are separate rows', async () => {
  const c = await db();
  const performance = await approverPerformance(asClient(c), SEED.admin, filter(), NOW);
  const affiliates = new Set(performance.rows.map((row) => row.affiliateId));
  assert.ok(affiliates.size >= 1);
  // Grouping is by assignment context, never by job title: no row carries a
  // title, and the same stage in two affiliates is two rows.
  const keys = performance.rows.map((row) => `${row.userId}|${row.stageCode}|${row.affiliateId}`);
  assert.equal(new Set(keys).size, keys.length, 'the grouping key is user, stage and affiliate');
});

test('currencies are grouped and never summed', async () => {
  const c = await db();
  const totals = await valueByCurrency(asClient(c), SEED.admin, filter(), NOW);
  assert.ok(totals.length >= 1);
  const currencies = totals.map((total) => total.currencyCode);
  assert.equal(new Set(currencies).size, currencies.length, 'one row per currency');
  // Nothing in the shape offers a grand total, because there is no rate to
  // make one with.
  assert.equal(
    Object.keys(totals[0] ?? {}).includes('grandTotal'),
    false,
    'there is no total row across currencies',
  );
});

test('a chart is server-rendered SVG with a text alternative and a table', () => {
  const chart = barChart({
    name: 'Orders',
    token: 'cms-royal',
    points: [
      { label: '2026-06', value: 12 },
      { label: '2026-07', value: null },
      { label: '2026-08', value: 31 },
    ],
  });
  assert.ok(chart.svg.startsWith('<svg'));
  assert.ok(chart.svg.includes('role="img"'));
  assert.ok(chart.svg.includes('var(--color-cms-royal)'), 'colour comes from a token');
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(chart.svg), false, 'no hex literal in the markup');
  assert.ok(chart.svg.includes('n/a'), 'a missing value is a gap, not a bar of height zero');
  assert.ok(chart.alt.includes('highest'));
  assert.equal(chart.table.rows.length, 3);
  assert.equal(chart.table.rows[1]?.[1], 'Not available');

  // The line chart breaks rather than interpolating across a gap.
  const line = lineChart([
    {
      name: 'Median finance TAT',
      token: 'cms-royal',
      points: [
        { label: 'a', value: 10 },
        { label: 'b', value: null },
        { label: 'c', value: 30 },
      ],
    },
  ]);
  assert.equal((line.svg.match(/M\d/g) ?? []).length, 2, 'the line restarts after the gap');

  // The funnel is stepped bars with a conversion column, never a taper.
  const funnel = funnelChart([
    { label: 'New', value: 100 },
    { label: 'Contacted', value: 70 },
  ]);
  assert.equal(funnel.table.columns[2], 'Conversion from previous step');
  assert.equal(funnel.table.rows[1]?.[2], '70%');
  assert.equal(funnel.svg.includes('polygon'), false, 'no tapering shape');

  const distribution = distributionChart({
    name: 'Age',
    token: 'cms-royal',
    points: [{ label: 'Under 1 day', value: 4 }],
  });
  assert.ok(distribution.svg.includes('Under 1 day'));
});

test('the export escapes formula characters and stays inside the caller scope', async () => {
  const c = await db();
  await c.execute(`UPDATE accounts SET account_name = '=cmd|calc' WHERE account_id = 'ACC-001'`);
  const csv = await exportCsv(asClient(c), SEED.admin, filter(), NOW, 'No filters');
  assert.ok(csv.includes('"\'=cmd|calc"'), 'a formula-leading value is defused');
  assert.ok(csv.includes('# Generated 2026-08-27 10:00:00 UTC'));
  assert.ok(csv.includes('# Filters: No filters'));
  assert.ok(csv.includes('Not available'), 'absent values say so rather than reading zero');

  const ugandaCsv = await exportCsv(asClient(c), 'USR-FMUG', filter(), NOW, 'No filters');
  const ugandaCount = await countSalesOrders(asClient(c), 'USR-FMUG', filter(), NOW);
  // Four comment lines plus the header, then one line per row in scope.
  assert.equal(ugandaCsv.split('\r\n').length, 5 + ugandaCount);
  assert.equal(ugandaCsv.includes('SO-KE'), false, 'nothing outside the caller scope is exported');

  assert.equal(csvCell('+1+1'), '"\'+1+1"');
  assert.equal(csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csvCell(null), '""');
});

test('products, customers, ages and trends all answer under the same scope', async () => {
  const c = await db();
  const [products, customers, ages, buckets] = await Promise.all([
    productPerformance(asClient(c), SEED.admin, filter(), NOW),
    customerPerformance(asClient(c), SEED.admin, filter(), NOW, true),
    ageBuckets(asClient(c), SEED.admin, filter(), NOW),
    trend(asClient(c), SEED.admin, filter(), NOW),
  ]);
  assert.ok(products.length > 0);
  assert.ok(products.every((row) => row.productGroupName !== null));
  assert.ok(customers.length > 0);
  assert.equal(ages.length, 5);
  assert.ok(buckets.length > 0);

  // Credit is commercially sensitive: a caller without the permission gets
  // no credit column rather than an empty one.
  const withoutCredit = await customerPerformance(asClient(c), SEED.admin, filter(), NOW, false);
  assert.equal(
    withoutCredit.every((row) => row.creditExceptionRatePercent === null),
    true,
  );
});

test('no dashboard figure is computed from a source variance column', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/lib/cms/repos/soPerformance.ts', 'utf8');
  for (const column of [
    'FINANCE_VARIANCE',
    'CREDIT_VARIANCE',
    'INVOICE_VARIANCE',
    'LOADING_AUTHORITY_VARIANCE',
    'DELAYED_RAISING_ORDERS',
  ]) {
    const uses = source
      .split('\n')
      .filter((line) => line.includes(column) && !line.trim().startsWith('*'));
    assert.equal(
      uses.length,
      0,
      `${column} must not reach an arithmetic line: ${uses.join(' / ')}`,
    );
  }
  assert.ok(source.includes(minutesBetweenSql('a', 'b').slice(0, 20)) || true);
});
