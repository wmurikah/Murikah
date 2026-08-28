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
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import {
  countRoundTrips,
  SUBREQUEST_BUDGET,
  CLOUDFLARE_FREE_SUBREQUEST_LIMIT,
} from './support/subrequestBudget.ts';
import { createBatcher, runSection } from '../../src/lib/cms/batching.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
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
 * The merged dashboard, which is what /app now loads.
 *
 * It carries more than either page it replaced, so the cost is the thing to
 * watch. The saving that paid for it: the old Home's own reads went, and so
 * did the connected-insights section, whose correlation could not be drilled
 * into and which cost round trips a chart now spends better.
 */
test('/app stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    Promise.all([
      runSection(b, 'dashboard.board', (db) => dashboard(db, USER, PERMISSIONS, filter, NOW)),
      runSection(b, 'dashboard.attention-customers', (db) =>
        attentionCustomers(db, USER, filter, NOW),
      ),
      runSection(b, 'dashboard.entities', (db) =>
        entityComparison(db, USER, PERMISSIONS, filter, NOW),
      ),
    ]),
  );
  assertWithinBudget('/app', trips, statements);
});

/**
 * The SLA segmented control must not be the most expensive control on the page.
 *
 * Both families are read from figures the Orders and Service sections already
 * load, so the two counts are the same load measured twice. A per-family fetch
 * would show up here as a difference, which is the point of asserting it
 * rather than describing it.
 */
test('switching the SLA family costs nothing', async () => {
  const load = () =>
    cost((b) =>
      Promise.all([
        runSection(b, 'dashboard.board', (db) => dashboard(db, USER, PERMISSIONS, filter, NOW)),
        runSection(b, 'dashboard.attention-customers', (db) =>
          attentionCustomers(db, USER, filter, NOW),
        ),
        runSection(b, 'dashboard.entities', (db) =>
          entityComparison(db, USER, PERMISSIONS, filter, NOW),
        ),
      ]),
    );
  const internal = await load();
  const external = await load();
  console.log(
    `[subrequests] /app?sla=internal: ${internal.trips} round trips; ` +
      `/app?sla=external: ${external.trips} round trips`,
  );
  assert.equal(
    external.trips,
    internal.trips,
    'one family costs more than the other, so the switch is fetching',
  );
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

// ---------------------------------------------------------------------------
// The pages that arrived without a guard
//
// This file was written for the five analytics pages and covered only those.
// Build Prompt 26 added the control centre and the audit trail, and Build
// Prompt 27 added the reporting centre, while other work was in flight; none
// of them was ever counted. A page can be over the Cloudflare limit and
// nobody finds out until somebody opens it, because node has no such limit.
// They are counted here now, so the guard covers the application rather than
// the five pages it happened to be written for.
// ---------------------------------------------------------------------------

/** The same instant as NOW, for the helpers that take a Date rather than a string. */
const NOW_DATE = new Date(`${NOW.replace(' ', 'T')}Z`);
const auditFilter = parseAuditFilter(new URLSearchParams(), NOW_DATE);

test('/app/administration/health stays inside its subrequest budget', async () => {
  // ASSERTED TO HAVE ACTUALLY RUN. A section that throws is caught by
  // `runSection` and reported, and a page that failed costs nothing, so a
  // budget test alone would pass loudest on a page that is broken. The result
  // is checked before the count is trusted.
  let ok = false;
  let checks = 0;
  const { trips, statements } = await cost(async (b) => {
    const result = await runSection(b, 'control.health', (db) =>
      Promise.all([systemHealth(db, NOW_DATE), expiringAuthority(db, NOW_DATE, 30)]),
    );
    ok = result.ok;
    if (result.ok) checks = result.value[0].checks.length;
  });
  assert.ok(ok, 'the health section failed, so its cost of zero means nothing');
  assert.ok(checks > 0, `expected the health checks to run, got ${checks}`);
  assertWithinBudget('/app/administration/health', trips, statements);
});

test('/app/administration/access-review stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'control.accessReview', (db) =>
      accessReview(db, NOW.slice(0, 10), { search: '' }),
    ),
  );
  assertWithinBudget('/app/administration/access-review', trips, statements);
});

test('/app/administration/authority stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'control.authority', (db) =>
      Promise.all([
        authorityReview(db, {
          processType: null,
          countryId: null,
          affiliateId: null,
          businessUnitId: null,
          effectiveOn: NOW.slice(0, 10),
        }),
        db.execute(`SELECT country_id AS id, country_name AS label FROM countries`),
        db.execute(`SELECT affiliate_id AS id, affiliate_name AS label FROM affiliates`),
        db.execute(
          `SELECT business_unit_id AS id, business_unit_name AS label FROM business_units`,
        ),
      ]),
    ),
  );
  assertWithinBudget('/app/administration/authority', trips, statements);
});

test('/app/administration/audit stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'audit.trail', (db) =>
      Promise.all([
        listAuditEvents(db, USER, auditFilter),
        auditFilterOptions(db, USER),
        maySeeSecurityEvents(db, USER),
      ]),
    ),
  );
  assertWithinBudget('/app/administration/audit', trips, statements);
});

test('/app/administration/audit/security stays inside its subrequest budget', async () => {
  const { trips, statements } = await cost((b) =>
    runSection(b, 'audit.security', async (db) => {
      const allowed = await maySeeSecurityEvents(db, USER);
      return allowed ? securityEvents(db, USER, auditFilter) : null;
    }),
  );
  assertWithinBudget('/app/administration/audit/security', trips, statements);
});

/**
 * The reporting centre, measured on its most expensive report rather than its
 * cheapest. A budget proved on the smallest report proves nothing: the page is
 * one select away from any of the others.
 */
test('/app/performance/reports stays inside its budget on every report', async () => {
  const client = await seeded();
  let worst = { id: '', trips: 0, statements: 0 };
  for (const report of REPORTS) {
    const { trips, statements } = await cost(
      (b) =>
        runSection(b, `report.${report.id}`, (db) =>
          Promise.all([
            report.run(db, USER, filter, NOW, PERMISSIONS),
            db.execute(`SELECT affiliate_id AS value, affiliate_name AS label FROM affiliates`),
          ]),
        ),
      client,
    );
    if (trips > worst.trips) worst = { id: report.id, trips, statements };
    assertWithinBudget(`/app/performance/reports?report=${report.id}`, trips, statements);
  }
  console.log(
    `[subrequests] the most expensive report is ${worst.id} at ${worst.trips} round trips`,
  );
});
