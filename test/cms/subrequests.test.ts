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
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import {
  dashboard,
  connectedInsights,
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

test('/app/executive stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    Promise.all([
      runSection(b, 'executive.dashboard', (db) => dashboard(db, USER, PERMISSIONS, filter, NOW)),
      runSection(b, 'executive.insights', (db) =>
        connectedInsights(db, USER, PERMISSIONS, filter, NOW),
      ),
      runSection(b, 'executive.attention-customers', (db) =>
        attentionCustomers(db, USER, filter, NOW),
      ),
      runSection(b, 'executive.entities', (db) =>
        entityComparison(db, USER, PERMISSIONS, filter, NOW),
      ),
    ]),
  );
  assertWithinBudget('/app/executive', trips, statements);
});

test('/app/orders/sales/performance stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'sales.performance', (db) =>
      Promise.all([
        soSummary(db, USER, filter, NOW),
        soApprovers(db, USER, filter, NOW),
        productPerformance(db, USER, filter, NOW),
        customerPerformance(db, USER, filter, NOW, true),
        ageBuckets(db, USER, filter, NOW),
        soTrend(db, USER, filter, NOW),
        db.execute(AFFILIATE_LIST),
      ]),
    ),
  );
  assertWithinBudget('/app/orders/sales/performance', trips, statements);
});

test('/app/orders/purchases/performance stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'purchases.performance', (db) =>
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
    ),
  );
  assertWithinBudget('/app/orders/purchases/performance', trips, statements);
});

test('/app/crm/analytics stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'crm.analytics', (db) =>
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
    ),
  );
  assertWithinBudget('/app/crm/analytics', trips, statements);
});

test('/app/service/analytics stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'service.analytics', (db) =>
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
    ),
  );
  assertWithinBudget('/app/service/analytics', trips, statements);
});

/**
 * The regression that actually bit, stated as a property.
 *
 * The executive dashboard's cost used to be linear in the number of active
 * affiliates: 30 subrequests each, 151 at five, 301 at ten. A business that
 * opened one more affiliate would have broken a page that worked the day
 * before. The cost must not follow the data.
 */
test('the executive dashboard does not get more expensive as affiliates are added', async () => {
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
          runSection(b, 'executive.dashboard', (db) =>
            dashboard(db, USER, PERMISSIONS, filter, NOW),
          ),
          runSection(b, 'executive.insights', (db) =>
            connectedInsights(db, USER, PERMISSIONS, filter, NOW),
          ),
          runSection(b, 'executive.attention-customers', (db) =>
            attentionCustomers(db, USER, filter, NOW),
          ),
          runSection(b, 'executive.entities', (db) =>
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
  assertWithinBudget('/app/executive at five affiliates', five.trips, five.statements);
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
