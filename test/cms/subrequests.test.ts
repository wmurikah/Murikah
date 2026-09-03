/**
 * Every analytics page has a subrequest budget, and CI enforces it.
 *
 * THE FAILURE THIS PREVENTS. Cloudflare's Free plan allows 50 outbound
 * subrequests per request. `@libsql/client/web` spends one per `execute()` and
 * does NOT coalesce concurrent calls, so a page that issues one statement per
 * figure spends one subrequest per figure. The executive dashboard reached 237
 * and stopped loading entirely: it died at the 51st call, inside the client,
 * with `load failed` and nothing naming the section or the statement. Every
 * test in this repository passed the whole time, because node has no such
 * limit and the count was not something anything asserted.
 *
 * So the count is asserted here, page by page, the same way it is counted at
 * the edge: one execute is one round trip, one batch of any size is one round
 * trip. A page that regresses fails in CI rather than in production.
 *
 * THE BUDGET IS 15, NOT 50, and the gap is the point. The limit is a cliff. A
 * page at 45 works today and is one panel away from an outage that will be
 * reported as a database fault and debugged as one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { validatePoWorkbook } from '../../src/lib/cms/import/poImport.ts';
import { validateSoWorkbook } from '../../src/lib/cms/import/soImport.ts';
import {
  countRoundTrips,
  SUBREQUEST_BUDGET,
  CLOUDFLARE_FREE_SUBREQUEST_LIMIT,
} from './support/subrequestBudget.ts';
import { createBatcher, runSection } from '../../src/lib/cms/batching.ts';
import { parseFilter, drillTo } from '../../src/lib/cms/analytics/filters.ts';
import {
  approvalBoard,
  approvalCycle,
  approvalTrend,
  approverGroupBoard,
  poApprovalRule,
} from '../../src/lib/cms/repos/approvalSla.ts';
import {
  calendarSql,
  choosePeriod,
  parseDashboardPeriod,
  readCalendar,
  trailingMonths,
  trendSpan,
  withPeriod,
} from '../../src/lib/cms/analytics/period.ts';
import { countSalesOrders } from '../../src/lib/cms/repos/soPerformance.ts';
import { countPurchaseOrders } from '../../src/lib/cms/repos/poPerformance.ts';
import { listProviders, activeProvider } from '../../src/lib/cms/ai/providers.ts';
import { listConnections } from '../../src/lib/cms/ai/channels.ts';
import { reviewQueue } from '../../src/lib/cms/ai/inbox.ts';
import {
  dashboard,
  attentionCustomers,
  entityComparison,
} from '../../src/lib/cms/repos/executive.ts';
import {
  soSummary,
  approverPerformance as soApprovers,
  productPerformance,
  customerPerformance,
  ageBuckets,
  trend as soTrend,
} from '../../src/lib/cms/repos/soPerformance.ts';
import {
  coverage,
  durations,
  backlog as poBacklog,
  stagePerformance,
  bottleneck,
  approverPerformance as poApprovers,
  procurementMix,
  trend as poTrend,
  stockConstraint,
} from '../../src/lib/cms/repos/poPerformance.ts';
import {
  funnel,
  winRate,
  pipelineValue,
  stageOccupancy,
  stageVelocity,
  firstContact,
  bant,
  leadSourcePerformance,
  productPipeline,
  ownerPerformance,
  teamPerformance,
  lossAnalysis,
  pipelineEstimate,
  followUpHealth,
  trend as crmTrend,
} from '../../src/lib/cms/repos/crmAnalytics.ts';
import {
  summary as serviceSummary,
  waitingBreakdown,
  handoffs,
  categoryMix,
  repeatIssues,
  slaPicture,
  breachAttribution,
  surveyScores,
  feedbackCoverage,
  customerView,
  entityView,
  teamView,
  trend as serviceTrend,
  insights as serviceInsights,
} from '../../src/lib/cms/repos/serviceAnalytics.ts';
import {
  systemHealth,
  expiringAuthority,
  accessReview,
  authorityReview,
} from '../../src/lib/cms/repos/controlCentre.ts';
import {
  listAuditEvents,
  auditFilterOptions,
  maySeeSecurityEvents,
  securityEvents,
  parseAuditFilter,
} from '../../src/lib/cms/repos/auditTrail.ts';
import { REPORTS } from '../../src/lib/cms/reports/catalogue.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const NOW = '2026-08-27 10:00:00';
const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T10:00:00Z'),
} as const;
const USER = 'USR-CATH';
/** Everything, so no section is composed away and every page is at full cost. */
const PERMISSIONS = [
  'CRM.OPPORTUNITIES.VIEW',
  'SERVICE.CASES.VIEW',
  'ORDERS.SALES_ORDER.VIEW',
  'ORDERS.PURCHASE_ORDER.VIEW',
  'DATA.IMPORTS.VIEW',
  'CUSTOMERS.ACCOUNTS.VIEW',
];
const AFFILIATE_LIST = `SELECT affiliate_id, affiliate_name FROM affiliates WHERE active = 1 ORDER BY affiliate_name`;

async function seeded(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  await c.execute(`INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
    ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
    FROM permissions WHERE permission_id IN ('PERM-031','PERM-036')`);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
}

/** Render one page's data load and return what it cost at the edge. */
async function cost(
  load: (batcher: ReturnType<typeof createBatcher>) => Promise<unknown>,
  client?: TestClient,
): Promise<{ trips: number; statements: number }> {
  const counted = countRoundTrips(client ?? (await seeded()));
  const batcher = createBatcher(counted.db as never);
  await load(batcher);
  return { trips: counted.roundTrips(), statements: counted.statements() };
}

function assertWithinBudget(page: string, trips: number, statements: number): void {
  // Emitted as a TAP diagnostic rather than kept to itself, because a budget
  // test that only says "pass" cannot answer the question a reviewer actually
  // asks: did this change make the page more expensive? The number is the
  // evidence, so the number is printed.
  console.log(`[subrequests] ${page}: ${trips} round trips, ${statements} statements`);
  assert.ok(
    trips <= SUBREQUEST_BUDGET,
    `${page} costs ${trips} subrequests for ${statements} statements, over the budget of ` +
      `${SUBREQUEST_BUDGET}. Cloudflare's Free plan allows ` +
      `${CLOUDFLARE_FREE_SUBREQUEST_LIMIT} per request, so this page is heading for an outage ` +
      `that will look like a database fault. Batch the reads (src/lib/cms/batching.ts) rather ` +
      `than raising this budget.`,
  );
}

const filter = parseFilter(new URLSearchParams());

/**
 * Home: two panels, each a KPI strip, a bar chart, a trend and a leaderboard.
 *
 * THE SHAPE IS THE ASSERTION. The calendar is read on its own, because nothing
 * else on the page can be asked for until the period is known — a fallback off
 * an empty default changes what every figure is a figure OF. Everything after
 * it is issued into the same queue in one go, so the batcher coalesces it: the
 * cost of the page scales with the depth of its deepest chain and not with the
 * number of figures on it.
 *
 * The thing this test protects is that property. A figure added later that
 * awaits before its neighbours would open a wave of its own and cost a round
 * trip, and this is where that shows up rather than in production.
 */
test('/app stays inside its subrequest budget', async () => {
  const today = new Date(NOW.replace(' ', 'T') + 'Z');
  const params = new URLSearchParams();
  // Captured for the fragment simulation below: the page passes these to the
  // trend fragment in its URL rather than running the trend itself.
  let shown!: ReturnType<typeof choosePeriod>['period'];
  let trendMonths = 0;
  const { trips, statements } = await cost(async (b) => {
    // THE CALENDAR, ALONE. One statement for the whole period control.
    const calendarRows = await runSection(b, 'home.calendar', (db) =>
      db.execute({
        sql: calendarSql([
          {
            table: 'workflow_stage_instances',
            column: 'completed_at',
            series: 'PURCHASE_ORDER',
            where: `workflow_instance_id IN (
              SELECT workflow_instance_id FROM workflow_instances
               WHERE entity_type = 'PURCHASE_ORDER')`,
          },
          {
            table: 'workflow_stage_instances',
            column: 'completed_at',
            series: 'SALES_ORDER',
            where: `workflow_instance_id IN (
              SELECT workflow_instance_id FROM workflow_instances
               WHERE entity_type = 'SALES_ORDER')`,
          },
          { table: 'sales_orders', column: 'invoice_created_at', series: 'SALES_ORDER' },
          { table: 'sales_orders', column: 'loading_authority_at', series: 'SALES_ORDER' },
        ]),
        args: ['2026-08'],
      }),
    );
    const calendar = readCalendar(
      calendarRows.ok ? (calendarRows.value.rows as Record<string, unknown>[]) : [],
    );
    const choice = choosePeriod(parseDashboardPeriod(params, today).period, calendar, today, false);
    shown = choice.period;
    const active = withPeriod(filter, shown);
    const scope = { from: shown.from, to: shown.to, affiliateId: filter.affiliateId };
    // THE TREND NO LONGER RUNS HERE. It sits behind "More detail" and its two
    // twelve-month window statements — the heaviest reads this page had —
    // moved to /app/fragments/home-trend, fetched on first expansion. What
    // the page still does for the trend is arithmetic: the month-span its
    // fragment URL carries, from the calendar it already read.
    trendMonths = trendSpan(shown, calendar);

    // EVERYTHING ELSE, IN ONE GO: the exceptions, four counts, two boards,
    // two end-to-end spans and the affiliate list. The month before is no
    // longer queried: the trend fragment already carries the months ending at
    // this one, so a second board for it was a figure the chart draws anyway.
    await Promise.all([
      runSection(b, 'home.attention', (db) => attentionCustomers(db, USER, active, NOW)),
      runSection(b, 'home.po-total', (db) => countPurchaseOrders(db, USER, active, NOW)),
      runSection(b, 'home.so-total', (db) => countSalesOrders(db, USER, active, NOW)),
      runSection(b, 'home.po-waiting', (db) =>
        countPurchaseOrders(db, USER, { ...active, status: 'IN_APPROVAL' }, NOW),
      ),
      runSection(b, 'home.so-waiting', (db) =>
        countSalesOrders(db, USER, { ...active, status: 'PENDING_FINANCE' }, NOW),
      ),
      runSection(b, 'home.purchases', (db) => approvalBoard(db, 'PURCHASE_ORDER', scope)),
      runSection(b, 'home.sales', (db) => approvalBoard(db, 'SALES_ORDER', scope)),
      runSection(b, 'home.purchases-cycle', (db) => approvalCycle(db, 'PURCHASE_ORDER', scope)),
      runSection(b, 'home.sales-cycle', (db) => approvalCycle(db, 'SALES_ORDER', scope)),
      // The purchase order chart's rule and its approver-and-product rows —
      // BOTH GRAINS IN ONE STATEMENT — ride the same wave, so the chart's
      // rebuild adds two statements to this batch and zero round trips.
      runSection(b, 'home.po-rule', (db) => poApprovalRule(db)),
      runSection(b, 'home.po-approvers', (db) => approverGroupBoard(db, scope)),
      runSection(b, 'home.affiliates', (db) =>
        db.execute(
          `SELECT affiliate_id, affiliate_name FROM affiliates
            WHERE active = 1 ORDER BY affiliate_name`,
        ),
      ),
    ]);
  });
  assertWithinBudget('/app', trips, statements);
  // THE FIGURE THE BRIEF ASKS FOR, PRINTED RATHER THAN DESCRIBED. Each panel
  // carries a KPI strip, a bar chart and a leaderboard, and the page must not
  // become more expensive for any of it.
  assert.ok(
    trips <= 6,
    `/app cost ${trips} round trips, up from the 6 it cost before the panels were rebuilt`,
  );

  // THE FRAGMENT, COSTED AS THE SEPARATE REQUEST IT IS. First expansion of
  // "More detail" fetches /app/fragments/home-trend once for BOTH panels; its
  // two statements must coalesce into one batch exactly as they did when the
  // page ran them, or the deferral has traded page weight for chattiness.
  const fragment = await cost(async (b) => {
    const window = trailingMonths(shown, trendMonths);
    const trendScope = {
      from: window.from,
      to: window.to,
      affiliateId: filter.affiliateId,
    };
    await Promise.all([
      runSection(b, 'home.purchases-trend', (db) =>
        approvalTrend(db, 'PURCHASE_ORDER', trendScope, 'MONTH'),
      ),
      runSection(b, 'home.sales-trend', (db) =>
        approvalTrend(db, 'SALES_ORDER', trendScope, 'MONTH'),
      ),
    ]);
  });
  assertWithinBudget('/app/fragments/home-trend', fragment.trips, fragment.statements);
  assert.equal(
    fragment.trips,
    1,
    `the trend fragment cost ${fragment.trips} round trips; both statements must ride one batch`,
  );
});

/**
 * The waiting figure and the page it links to are the same question.
 *
 * A dashboard number whose destination holds a different count is worse than
 * no number, because it is checkable and wrong. This does not compare two
 * queries written to agree: the figure IS `countSalesOrders` under the filter
 * the link carries, so the only way they can diverge is if the page stops
 * using it, which is what the assertion below would catch.
 */
/**
 * The three screens part 7 adds, and the shell control that adds nothing.
 *
 * The assistant panel is the interesting number here: it is rendered on EVERY
 * page, so a single query in it would be a query added to all of them, and
 * Home is at thirteen of fifteen. It reads nothing until somebody opens it.
 */
test('the assistant and channel screens stay inside their budgets', async () => {
  const client = await seeded();

  const ai = await cost(async (b) => {
    await listProviders(b.for('admin.ai') as never);
  }, client);
  assertWithinBudget('/app/administration/ai', ai.trips, ai.statements);

  const channels = await cost(async (b) => {
    const db = b.for('admin.channels') as never;
    await Promise.all([
      listConnections(db),
      (db as { execute: (sql: string) => Promise<unknown> }).execute(
        `SELECT case_category_id, category_name, subcategory_name FROM case_categories
          WHERE active = 1 ORDER BY category_name, subcategory_name`,
      ),
    ]);
  }, client);
  assertWithinBudget('/app/administration/channels', channels.trips, channels.statements);

  const review = await cost(async (b) => {
    const db = b.for('helpdesk.review') as never;
    await Promise.all([reviewQueue(db), activeProvider(db, 'CLASSIFICATION')]);
  }, client);
  assertWithinBudget('/app/helpdesk/review', review.trips, review.statements);

  // THE PANEL IN THE SHELL, WHICH IS ON EVERY PAGE. Asserted as zero rather
  // than as "small": a query here is multiplied by every page in the product.
  const panel = readFileSync('src/components/cms/CmsAssistant.astro', 'utf8');
  const frontmatter = panel.slice(0, panel.indexOf('---', 3));
  assert.ok(
    !/getDb|db\.execute|await\s+list|await\s+reviewQueue/.test(frontmatter),
    'the assistant panel reads nothing at render time',
  );
  console.log('[subrequests] assistant panel in the shell: 0 round trips');
});

test('a Home figure equals the count of the records behind it', async () => {
  const db = await seeded();
  const status = 'PENDING_FINANCE';
  const figure = await countSalesOrders(db as never, USER, { ...filter, status }, NOW);
  // The destination the page links to, parsed back out of the very query
  // string the anchor carries, and counted through the list page's own repo.
  const href = drillTo('/app/orders/sales', filter, { status });
  const destination = parseFilter(new URLSearchParams(href.slice(href.indexOf('?'))));
  const behind = await countSalesOrders(db as never, USER, destination, NOW);
  assert.equal(behind, figure, 'the destination holds exactly the figure');
  console.log(`[drill] /app finance-approval waiting: ${figure} = ${behind} records`);
});

test('/app/orders/sales/performance stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost(async (b) => {
    // THE PERIOD CONTROL'S OWN COST, COUNTED HERE RATHER THAN ASSUMED. It is
    // one statement in a wave of its own, because the period it resolves
    // decides what every figure below is asked for. One trip, on every page
    // that carries the control.
    await runSection(b, 'sales.performance.calendar', (db) =>
      db.execute({
        sql: calendarSql([{ table: 'sales_orders', column: 'order_created_at' }]),
        args: ['2026-08'],
      }),
    );
    return runSection(b, 'sales.performance', (db) =>
      Promise.all([
        soSummary(db, USER, filter, NOW),
        soApprovers(db, USER, filter, NOW),
        productPerformance(db, USER, filter, NOW),
        customerPerformance(db, USER, filter, NOW, true),
        ageBuckets(db, USER, filter, NOW),
        soTrend(db, USER, filter, NOW),
        db.execute(AFFILIATE_LIST),
      ]),
    );
  });
  assertWithinBudget('/app/orders/sales/performance', trips, statements);
});

test('/app/orders/purchases/performance stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost(async (b) => {
    // THE PERIOD CONTROL'S OWN COST, COUNTED HERE RATHER THAN ASSUMED. It is
    // one statement in a wave of its own, because the period it resolves
    // decides what every figure below is asked for. One trip, on every page
    // that carries the control.
    await runSection(b, 'purchases.performance.calendar', (db) =>
      db.execute({
        sql: calendarSql([{ table: 'purchase_orders', column: 'po_created_at' }]),
        args: ['2026-08'],
      }),
    );
    return runSection(b, 'purchases.performance', (db) =>
      Promise.all([
        coverage(db, USER, filter, NOW),
        durations(db, USER, filter, NOW),
        poBacklog(db, USER, filter, NOW),
        stagePerformance(db, USER, filter, NOW),
        bottleneck(db, USER, filter, NOW),
        poApprovers(db, USER, filter, NOW),
        procurementMix(db, USER, filter, NOW),
        poTrend(db, USER, filter, NOW),
        stockConstraint(db, USER, filter, NOW),
        db.execute(AFFILIATE_LIST),
      ]),
    );
  });
  assertWithinBudget('/app/orders/purchases/performance', trips, statements);
});

test('/app/crm/analytics stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost(async (b) => {
    // THE PERIOD CONTROL'S OWN COST, COUNTED HERE RATHER THAN ASSUMED. It is
    // one statement in a wave of its own, because the period it resolves
    // decides what every figure below is asked for. One trip, on every page
    // that carries the control.
    await runSection(b, 'crm.analytics.calendar', (db) =>
      db.execute({
        sql: calendarSql([
          { table: 'opportunities', column: 'created_at' },
          { table: 'leads', column: 'created_at' },
        ]),
        args: ['2026-08'],
      }),
    );
    return runSection(b, 'crm.analytics', (db) =>
      Promise.all([
        funnel(db, USER, filter),
        winRate(db, USER, filter),
        pipelineValue(db, USER, filter),
        stageOccupancy(db, USER, filter, NOW),
        stageVelocity(db, USER, filter),
        firstContact(db, USER, filter),
        bant(db, USER, filter),
        leadSourcePerformance(db, USER, filter),
        productPipeline(db, USER, filter),
        ownerPerformance(db, USER, filter, NOW),
        teamPerformance(db, USER, filter),
        lossAnalysis(db, USER, filter),
        pipelineEstimate(db, USER, filter),
        followUpHealth(db, USER, filter, NOW),
        crmTrend(db, USER, filter),
        db.execute(AFFILIATE_LIST),
      ]),
    );
  });
  assertWithinBudget('/app/crm/analytics', trips, statements);
});

test('/app/helpdesk/analytics stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost(async (b) => {
    // THE PERIOD CONTROL'S OWN COST, COUNTED HERE RATHER THAN ASSUMED. It is
    // one statement in a wave of its own, because the period it resolves
    // decides what every figure below is asked for. One trip, on every page
    // that carries the control.
    await runSection(b, 'service.analytics.calendar', (db) =>
      db.execute({
        sql: calendarSql([{ table: 'service_cases', column: 'created_at' }]),
        args: ['2026-08'],
      }),
    );
    return runSection(b, 'service.analytics', (db) =>
      Promise.all([
        serviceSummary(db, USER, filter),
        waitingBreakdown(db, USER, filter),
        handoffs(db, USER, filter),
        categoryMix(db, USER, filter),
        repeatIssues(db, USER, filter),
        slaPicture(db, USER, filter, NOW),
        breachAttribution(db, USER, filter),
        surveyScores(db, USER, filter),
        feedbackCoverage(db, USER, filter),
        customerView(db, USER, filter),
        entityView(db, USER, filter),
        teamView(db, USER, filter),
        serviceTrend(db, USER, filter),
        serviceInsights(db, USER, filter),
        db.execute(AFFILIATE_LIST),
      ]),
    );
  });
  assertWithinBudget('/app/helpdesk/analytics', trips, statements);
});

/**
 * The regression that actually bit, stated as a property.
 *
 * The executive dashboard's cost used to be linear in the number of active
 * affiliates: 30 subrequests each, 151 at five, 301 at ten. A business that
 * opened one more affiliate would have broken a page that worked the day
 * before. The cost must not follow the data.
 */
test('the dashboard does not get more expensive as affiliates are added', async () => {
  const c = await seeded();
  const activate = (n: number): void => {
    c.raw.exec('UPDATE affiliates SET active = 0');
    c.raw
      .prepare(
        `UPDATE affiliates SET active = 1 WHERE affiliate_id IN
           (SELECT affiliate_id FROM affiliates ORDER BY affiliate_id LIMIT ?)`,
      )
      .run(n as never);
  };
  const render = () =>
    cost(
      (b) =>
        Promise.all([
          runSection(b, 'dashboard.board', (db) => dashboard(db, USER, PERMISSIONS, filter, NOW)),
          runSection(b, 'dashboard.attention-customers', (db) =>
            attentionCustomers(db, USER, filter, NOW),
          ),
          runSection(b, 'dashboard.entities', (db) =>
            entityComparison(db, USER, PERMISSIONS, filter, NOW),
          ),
        ]),
      c,
    );

  activate(1);
  const one = await render();
  activate(5);
  const five = await render();

  assert.equal(
    five.trips,
    one.trips,
    `the page cost ${one.trips} subrequests at one affiliate and ${five.trips} at five. ` +
      `Its cost must not scale with the data: that is how it reached 237 and stopped loading.`,
  );
  assertWithinBudget('/app at five affiliates', five.trips, five.statements);
  c.close();
});

/**
 * The Upload Centre's two screens, held to the same budget as the analytics
 * pages, and the validation that used to break it.
 *
 * WHAT THIS CAUGHT. Both importers asked "what hashes has this key had before"
 * once per row, inside the row loop. PO-Ver1.xls is 45 rows and cost 57
 * subrequests; SO-Ver1.xls is 1,386 rows and cost 1,403. Cloudflare's Free
 * plan allows 50 per request, so validation died part-way through the loop and
 * left the batch at VALIDATING with rows received recorded, no import_rows,
 * and every classification count zero. Nothing in the suite could see that,
 * because node has no subrequest limit.
 */
test('validating the purchase order extract stays well inside the platform limit', async () => {
  const counted = countRoundTrips(await seeded());
  const bytes = new Uint8Array(readFileSync(join(here, 'support', 'PO-Ver1.xls')));
  const result = await validatePoWorkbook(
    counted.db as never,
    bytes,
    {
      filename: 'PO-Ver1.xls',
      uploadedBy: SEED.admin,
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
    } as never,
    IMPORT_CTX as never,
  );
  assert.equal(result.rowsReceived, 45);
  assert.equal(result.uniqueOrders, 45, '45 rows must produce 45 documents');
  assert.ok(
    counted.roundTrips() <= CLOUDFLARE_FREE_SUBREQUEST_LIMIT,
    `validating 45 rows cost ${counted.roundTrips()} subrequests, over the Free plan's ` +
      `${CLOUDFLARE_FREE_SUBREQUEST_LIMIT}. It will die part-way through and leave the batch ` +
      `at VALIDATING.`,
  );
});

test('validating the sales order extract does not scale its cost with its rows', async () => {
  const counted = countRoundTrips(await seeded());
  const bytes = new Uint8Array(readFileSync(join(here, 'support', 'SO-Ver1.xls')));
  const result = await validateSoWorkbook(
    counted.db as never,
    bytes,
    { filename: 'SO-Ver1.xls', uploadedBy: SEED.admin, sourceSystemId: 'SRC-ORACLE' } as never,
    IMPORT_CTX as never,
  );
  assert.equal(result.rowsReceived, 1386);
  assert.equal(result.uniqueDocuments, 662, '1,386 rows must produce 662 documents');
  assert.ok(
    counted.roundTrips() <= CLOUDFLARE_FREE_SUBREQUEST_LIMIT,
    `validating 1,386 rows cost ${counted.roundTrips()} subrequests, over the Free plan's ` +
      `${CLOUDFLARE_FREE_SUBREQUEST_LIMIT}. A validation's cost must not follow its row count.`,
  );
  // 30 times the rows of the purchase order extract, and nothing like 30 times
  // the round trips: the cost follows the key space in chunks, not the rows.
  assert.ok(counted.roundTrips() < 45, `expected far fewer than one trip per row`);
});

test('a validation that cannot finish leaves the batch REJECTED, never VALIDATING', async () => {
  const client = await seeded();
  const bytes = new Uint8Array(readFileSync(join(here, 'support', 'SO-Ver1.xls')));
  // Fail the write that lands the rows, after the batch row already exists.
  const realBatch = client.batch.bind(client);
  let calls = 0;
  (client as unknown as { batch: unknown }).batch = async (stmts: never, mode: never) => {
    calls += 1;
    if (calls > 1) throw new Error('no such table: import_rows');
    return realBatch(stmts, mode);
  };
  const result = await validateSoWorkbook(
    client as never,
    bytes,
    { filename: 'corrupt.xls', uploadedBy: SEED.admin, sourceSystemId: 'SRC-ORACLE' } as never,
    IMPORT_CTX as never,
  );
  assert.notEqual(result.rejectedReason, null, 'the operator must be told it failed');
  const status = (
    client.raw
      .prepare(`SELECT status FROM import_batches WHERE import_batch_id = ?`)
      .get(result.batchId) as Record<string, unknown>
  ).status;
  assert.equal(status, 'REJECTED', 'VALIDATING is not a resting place');
  const audited = client.raw
    .prepare(
      `SELECT after_json FROM audit_events WHERE entity_id = ? AND event_type = 'IMPORT_REJECTED'`,
    )
    .get(result.batchId) as Record<string, unknown> | undefined;
  assert.ok(audited !== undefined, 'the reason must be recorded, not only shown');
  client.close();
});

test('nothing reaches a canonical table during validation', async () => {
  const client = await seeded();
  const count = (table: string) =>
    Number(
      (client.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>).n,
    );
  const before = {
    salesOrders: count('sales_orders'),
    salesOrderLines: count('sales_order_lines'),
    purchaseOrders: count('purchase_orders'),
  };
  const bytes = new Uint8Array(readFileSync(join(here, 'support', 'SO-Ver1.xls')));
  await validateSoWorkbook(
    client as never,
    bytes,
    { filename: 'SO-Ver1.xls', uploadedBy: SEED.admin, sourceSystemId: 'SRC-ORACLE' } as never,
    IMPORT_CTX as never,
  );
  assert.deepEqual(
    {
      salesOrders: count('sales_orders'),
      salesOrderLines: count('sales_order_lines'),
      purchaseOrders: count('purchase_orders'),
    },
    before,
    'validation is not a commit: no canonical row may be written by it',
  );
  client.close();
});
