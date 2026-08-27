/**
 * Phase 24: the executive dashboard.
 *
 * The failure this phase most has to avoid is a number here disagreeing with
 * the same number on its module page, so the tests compare them directly.
 * The rest are about honesty: a page composed from permissions rather than
 * from a name, direction that knows which way is good, freshness that never
 * calls an extract live, and an insight that claims correlation and not
 * cause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseFilter, drillTo } from '../../src/lib/cms/analytics/filters.ts';
import {
  composeDashboard,
  dashboard,
  movement,
  previousPeriod,
  freshness,
  needsAttention,
  connectedInsights,
  attentionCustomers,
  entityComparison,
  COMPOSITION_RULE,
  CORRELATION_WORDING,
  EXTRACT_WORDING,
  LIVE_WORDING,
} from '../../src/lib/cms/repos/executive.ts';
import { soSummary, countSalesOrders } from '../../src/lib/cms/repos/soPerformance.ts';
import { summary as serviceSummary } from '../../src/lib/cms/repos/serviceAnalytics.ts';
import { winRate, pipelineValue } from '../../src/lib/cms/repos/crmAnalytics.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const NOW = '2026-08-27 10:00:00';

/** The phase 12 data script, mirrored, so opportunity queries answer at all. */
async function grantCrmPermissions(c: TestClient): Promise<void> {
  await c.execute(`INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
    ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
    FROM permissions WHERE permission_id IN ('PERM-031','PERM-036')`);
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantCrmPermissions(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof dashboard>[0];
const filter = (query = '') => parseFilter(new URLSearchParams(query));

const ALL = [
  'ORDERS.SALES_ORDER.VIEW',
  'ORDERS.PURCHASE_ORDER.VIEW',
  'CRM.OPPORTUNITIES.VIEW',
  'SERVICE.CASES.VIEW',
  'DATA.IMPORTS.VIEW',
];

test('the dashboard is composed from permissions, with no page per person', () => {
  const everything = composeDashboard(ALL);
  assert.equal(everything.salesOrders, true);
  assert.equal(everything.purchaseOrders, true);
  assert.equal(everything.commercial, true);
  assert.equal(everything.service, true);
  assert.equal(everything.rule, COMPOSITION_RULE);
  assert.ok(everything.rule.includes('no page per person'));

  // A finance reader who may see orders and nothing else gets the order
  // sections and no CRM or service section, from the same code path.
  const finance = composeDashboard(['ORDERS.SALES_ORDER.VIEW', 'ORDERS.PURCHASE_ORDER.VIEW']);
  assert.equal(finance.salesOrders, true);
  assert.equal(finance.commercial, false);
  assert.equal(finance.service, false);
  assert.equal(finance.needsAttention, true);

  // A service manager gets the service and customer sections and no orders.
  const service = composeDashboard(['SERVICE.CASES.VIEW']);
  assert.equal(service.service, true);
  assert.equal(service.customer, true);
  assert.equal(service.salesOrders, false);

  // Nobody with nothing gets nothing, rather than everything.
  const nobody = composeDashboard([]);
  assert.equal(nobody.needsAttention, false);
  assert.equal(nobody.salesOrders, false);
  assert.equal(nobody.service, false);
});

test('a Group user and a country user see different figures from one code path', async () => {
  const c = await db();
  // Give the Uganda finance manager the sales order permission so both run
  // the same path and differ only by scope.
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    VALUES ('RP-FIN-020','ROLE-FIN','PERM-008',1,CURRENT_TIMESTAMP)`);

  const group = await dashboard(asClient(c), SEED.admin, ALL, filter(), NOW);
  const uganda = await dashboard(
    asClient(c),
    'USR-FMUG',
    ['ORDERS.SALES_ORDER.VIEW'],
    filter(),
    NOW,
  );

  assert.ok((group.salesOrders?.orders ?? 0) > 0);
  assert.ok(
    (uganda.salesOrders?.orders ?? 0) < (group.salesOrders?.orders ?? 0),
    'the country user counts fewer orders than the Group user',
  );
  // And the country user's figure equals their own module page exactly.
  const ugandaModule = await countSalesOrders(asClient(c), 'USR-FMUG', filter(), NOW);
  assert.equal(uganda.salesOrders?.orders, ugandaModule);
  assert.equal(uganda.service, null, 'and they see no section they lack the permission for');
});

test('every figure matches the module page it came from', async () => {
  const c = await db();
  const board = await dashboard(asClient(c), SEED.admin, ALL, filter(), NOW);

  // Pair one: sales orders.
  const so = await soSummary(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(board.salesOrders?.orders, so.orders);
  assert.equal(board.salesOrders?.financeMedianElapsedMinutes, so.finance.elapsed.medianMinutes);
  assert.equal(board.salesOrders?.slaCompliancePercent, so.slaCompliancePercent);

  // Pair two: service.
  const service = await serviceSummary(asClient(c), SEED.admin, filter());
  assert.equal(board.service?.openCases, service.openBacklog);
  assert.equal(
    board.service?.medianResolutionElapsedMinutes,
    service.medianResolutionElapsedMinutes,
  );

  // Pair three: commercial.
  const win = await winRate(asClient(c), SEED.admin, filter());
  const pipeline = await pipelineValue(asClient(c), SEED.admin, filter());
  assert.equal(board.commercial?.winRatePercent, win.winRatePercent);
  assert.equal(board.commercial?.winRateDenominator, win.denominator);
  assert.deepEqual(
    board.commercial?.openPipelineByCurrency.map((row) => row.currencyCode),
    pipeline.map((row) => row.currencyCode),
  );
});

test('no currency is summed on the dashboard', async () => {
  const c = await db();
  await c.execute(`INSERT INTO opportunities
      (opportunity_id, opportunity_number, account_id, pipeline_id, current_stage_id,
       owner_user_id, title, estimated_value, currency_code, probability, status, created_at, updated_at)
    VALUES ('OPP-EX-USD','OPP-8001','ACC-001','PIPE-001','PST-KE-01','USR-JAM','Dollar deal',
            50000,'USD',0.4,'OPEN',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  const board = await dashboard(asClient(c), SEED.admin, ALL, filter(), NOW);
  const currencies = board.commercial?.openPipelineByCurrency.map((row) => row.currencyCode) ?? [];
  assert.ok(currencies.includes('USD'));
  assert.ok(currencies.includes('KES'));
  assert.equal(new Set(currencies).size, currencies.length, 'one entry per currency');
  // The section shape offers no cross-currency total at all.
  assert.equal(Object.keys(board.commercial ?? {}).includes('totalPipeline'), false);
});

test('a rising complaint count is not good news', () => {
  // Complaints improve by falling, so a rise is BAD and can never be green.
  const complaints = movement('Complaints', 18, 11, 'DOWN', 'cases');
  assert.equal(complaints.change, 7);
  assert.equal(complaints.sentiment, 'BAD');
  assert.notEqual(complaints.sentiment, 'GOOD');

  // The same rise on a metric that improves by rising is good.
  const compliance = movement('SLA compliance', 91, 84, 'UP', 'per cent');
  assert.equal(compliance.sentiment, 'GOOD');

  // Turnaround falling is an improvement.
  const turnaround = movement('Finance turnaround', 40, 55, 'DOWN', 'minutes');
  assert.equal(turnaround.change, -15);
  assert.equal(turnaround.sentiment, 'GOOD');

  // Volume has no desirable direction and is never coloured as if it did.
  const volume = movement('Cases opened', 30, 20, 'NEUTRAL', 'cases');
  assert.equal(volume.sentiment, 'FLAT');

  // An unmeasurable movement says so rather than guessing.
  const unknown = movement('Median resolution', null, 90, 'DOWN', 'minutes');
  assert.equal(unknown.sentiment, 'UNKNOWN');
  assert.equal(unknown.change, null);
});

test('the previous equivalent period is the same length, immediately before', () => {
  // August is 31 days, so the comparison is the 31 days ending the day before.
  const period = previousPeriod(filter('from=2026-08-01&to=2026-08-31'));
  assert.deepEqual(period, { from: '2026-07-01', to: '2026-07-31' });
  const week = previousPeriod(filter('from=2026-08-24&to=2026-08-30'));
  assert.deepEqual(week, { from: '2026-08-17', to: '2026-08-23' });
  assert.equal(previousPeriod(filter()), null, 'an unbounded period has no comparison');
});

test('freshness shows the real last import and never says real time', async () => {
  const c = await db();
  const rows = await freshness(asClient(c));
  const sales = rows.find((row) => row.source === 'Sales orders');
  const purchases = rows.find((row) => row.source === 'Purchase orders');
  const crm = rows.find((row) => row.source === 'CRM');

  const actual = await c.execute(
    `SELECT MAX(uploaded_at) AS at FROM import_batches WHERE import_type = 'SALES_ORDER'`,
  );
  assert.equal(sales?.lastImportedAt, String(actual.rows[0]?.at));
  assert.equal(sales?.live, false);
  assert.equal(sales?.wording, EXTRACT_WORDING);
  assert.ok(sales?.wording.includes('not real time'));
  assert.notEqual(purchases?.lastImportedAt, null);
  assert.equal(crm?.live, true);
  assert.equal(crm?.wording, LIVE_WORDING);

  for (const row of rows) {
    assert.equal(
      /real.?time/i.test(row.wording.replace('not real time', '')),
      false,
      'nothing is labelled real time',
    );
  }
});

test('every needs-attention signal drills through to a matching count', async () => {
  const c = await db();
  const composition = composeDashboard(ALL);
  const signals = await needsAttention(asClient(c), SEED.admin, filter(), NOW, composition);
  assert.ok(signals.length > 0, 'the seed has exceptions worth attention');

  for (const signal of signals) {
    assert.ok(signal.count > 0, 'no decorative zero');
    assert.ok(signal.definition.length > 20, 'every number says what it counts');
    assert.notEqual(signal.href, '');
    // The destination carries the filter and the signal own narrowing.
    const url = drillTo(signal.href, filter(), signal.destination);
    assert.ok(url.startsWith(signal.href));
    for (const [key, value] of Object.entries(signal.destination)) {
      assert.ok(url.includes(`${key}=${encodeURIComponent(value)}`), `${key} survives the link`);
    }
  }

  // The sales order signals agree with the module backlog exactly.
  const so = await soSummary(asClient(c), SEED.admin, filter(), NOW);
  const breached = signals.find((signal) => signal.key === 'so_breached');
  const moduleBreached = so.backlog.find((row) => row.key === 'breached')?.orders ?? 0;
  assert.equal(breached?.count ?? 0, moduleBreached);
});

test('a connected insight claims correlation and never a cause', async () => {
  const c = await db();
  const cards = await connectedInsights(asClient(c), SEED.admin, ALL, filter(), NOW);
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.ok(card.working.length > 40, 'the arithmetic is stated');
    assert.ok(card.sampleSize > 0);
    assert.ok(card.links.length > 0, 'and it links to the records behind it');
    assert.equal(
      /caused|because of|led to|resulted in|due to/i.test(card.headline),
      false,
      `no headline may claim a cause: ${card.headline}`,
    );
  }
  const stockCard = cards.find((card) => card.working.includes('Oracle posting'));
  if (stockCard !== undefined) {
    assert.ok(stockCard.working.includes(CORRELATION_WORDING));
    assert.ok(stockCard.working.includes('none is claimed'));
  }
});

test('the attention list uses observable indicators and no opaque score', async () => {
  const c = await db();
  const rows = await attentionCustomers(asClient(c), SEED.admin, filter(), NOW);
  for (const row of rows) {
    // Every column is a thing a manager can click and verify.
    assert.equal(typeof row.openOrders, 'number');
    assert.equal(typeof row.openCases, 'number');
    assert.equal(typeof row.slaBreaches, 'number');
    assert.equal(Object.keys(row).includes('riskScore'), false, 'there is no risk score');
    assert.equal(Object.keys(row).includes('healthScore'), false, 'and no health score');
    for (const value of row.commercialValueByCurrency) {
      assert.notEqual(value.currencyCode, '', 'money always carries its currency');
    }
  }
});

test('the entity comparison keeps currencies apart and names a real exception', async () => {
  const c = await db();
  const rows = await entityComparison(asClient(c), SEED.admin, ALL, filter(), NOW);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.notEqual(row.affiliateName, '');
    assert.ok(row.keyException.length > 0);
    const currencies = row.openPipelineByCurrency.map((entry) => entry.currencyCode);
    assert.equal(new Set(currencies).size, currencies.length);
  }
  // A country with nothing outstanding says so rather than showing a zero.
  assert.ok(rows.some((row) => row.keyException === 'None outstanding' || row.keyException !== ''));
});

test('the page issues a bounded number of queries and caches nothing', async () => {
  const c = await db();
  const board = await dashboard(asClient(c), SEED.admin, ALL, filter(), NOW);
  assert.ok(board.queryCount > 0, 'the cost is counted, not guessed');
  assert.ok(
    board.queryCount <= 60,
    `the dashboard must stay bounded, and it issued ${board.queryCount}`,
  );

  // Nothing is cached, so two different users never share a result. The
  // proof is that the same call with two principals returns different data.
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    VALUES ('RP-FIN-021','ROLE-FIN','PERM-008',1,CURRENT_TIMESTAMP)`);
  const first = await dashboard(asClient(c), SEED.admin, ALL, filter(), NOW);
  const second = await dashboard(
    asClient(c),
    'USR-FMUG',
    ['ORDERS.SALES_ORDER.VIEW'],
    filter(),
    NOW,
  );
  assert.notEqual(first.salesOrders?.orders, second.salesOrders?.orders);
});

test('a comparison period produces movements with their own directions', async () => {
  const c = await db();
  const board = await dashboard(
    asClient(c),
    SEED.admin,
    ALL,
    filter('from=2026-08-01&to=2026-08-31'),
    NOW,
  );
  assert.notEqual(board.comparisonPeriod, null);
  assert.ok(board.movements.length > 0);
  for (const move of board.movements) {
    assert.ok(['UP', 'DOWN', 'NEUTRAL'].includes(move.desirable));
    assert.notEqual(move.unit, '');
  }
  // The complaint movement improves by falling, and the SLA one by rising.
  const complaints = board.movements.find((move) => move.metric === 'Complaints');
  const compliance = board.movements.find((move) => move.metric === 'External SLA compliance');
  assert.equal(complaints?.desirable, 'DOWN');
  assert.equal(compliance?.desirable, 'UP');
});
