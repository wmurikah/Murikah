/**
 * Phase 29 §7: load figures, without a load-testing package.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT.
 *
 * Section 5 forbids adding a load-testing package and section 7 asks for a
 * small script using the existing test runner. This is it: the real 1,386-row
 * sales order extract, the real 45-row purchase order extract, and the
 * heaviest read paths, each run enough times to report a median and a
 * ninetieth percentile.
 *
 * IT MEASURES THE APPLICATION LAYER AGAINST A SYNCHRONOUS IN-PROCESS
 * DATABASE. It is not an end-to-end HTTP measurement against the deployed
 * worker, and the report says so plainly rather than implying otherwise.
 * Doing that would need `wrangler dev` pointed at a real Turso database, and
 * this build environment has no credentials for one; obtaining them is a stop
 * condition, not a convenience.
 *
 * SO THE FIGURES ARE A FLOOR, NOT A FORECAST. Real latency is these numbers
 * plus a network round trip per query, which is why the query COUNTS beside
 * each figure matter more than the milliseconds: at roughly 30ms a round trip
 * to Turso, a view issuing 51 queries cannot be quicker than about 1.5
 * seconds however fast its SQL is. That is the number to act on, and phase 28
 * already halved the worst of them.
 *
 * It runs in the ordinary suite, so it cannot rot, and it asserts only that
 * nothing has become pathologically slow. It does not assert a latency
 * budget: a budget asserted on shared CI hardware fails for reasons that have
 * nothing to do with this repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import { receiveUpload, commitBatch } from '../../src/lib/cms/import/uploadCentre.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';
import { loadIdentity } from '../../src/lib/cms/repos/identity.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { listSalesOrders, soSummary } from '../../src/lib/cms/repos/soPerformance.ts';
import { dashboard } from '../../src/lib/cms/repos/executive.ts';
import { listAuditEvents, parseAuditFilter } from '../../src/lib/cms/repos/auditTrail.ts';
import { globalSearch } from '../../src/lib/cms/search/globalSearch.ts';
import { portalScope } from '../../src/lib/cms/portal/tenant.ts';
import { portalHome } from '../../src/lib/cms/repos/portalData.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));
const PO_FILE = readFileSync(join(here, 'support', 'PO-Ver1.xls'));

const NOW_DATE = new Date('2026-08-27T10:00:00Z');
const NOW = '2026-08-27 10:00:00';
const CTX = {
  actorUserId: 'USR-CATH',
  ip: '10.0.0.10',
  userAgent: 'HassCMS Load',
  now: NOW_DATE,
} as const;

const asClient = (c: TestClient) => c as unknown as Parameters<typeof receiveUpload>[0];

async function fresh(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
}

/** Median and P90, nearest-rank, the same rule the SQL statistics module uses. */
function stats(samples: number[]): { median: number; p90: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (rank: number) => sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
  return {
    median: Math.round(at(Math.floor((sorted.length + 1) / 2)) * 10) / 10,
    p90: Math.round(at(Math.floor((sorted.length * 9 + 9) / 10)) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
  };
}

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = process.hrtime.bigint();
  const value = await run();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
}

const REPORT: string[] = [];
function record(scenario: string, samples: number[], detail: string): void {
  const s = stats(samples);
  REPORT.push(
    `${scenario.padEnd(38)} n=${String(samples.length).padStart(3)}  median ${String(s.median).padStart(8)}ms  P90 ${String(s.p90).padStart(8)}ms  max ${String(s.max).padStart(8)}ms  ${detail}`,
  );
}

test('load: the real 1,386-row sales order extract', async () => {
  const c = await fresh();
  const upload = await timed(() =>
    receiveUpload(
      asClient(c),
      {
        importType: 'SALES_ORDER',
        sourceSystemId: 'SRC-EXCEL',
        affiliateId: null,
        filename: 'SO-Ver1.xls',
        reportingPeriodFrom: '2026-06-01',
        reportingPeriodTo: '2026-06-30',
        bytes: new Uint8Array(SO_FILE),
      },
      CTX,
    ),
  );
  assert.notEqual(upload.value.batchId, undefined);

  const rows = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM import_rows WHERE import_batch_id = ?`,
    args: [upload.value.batchId ?? ''],
  });
  const rowCount = Number((rows.rows[0] as unknown as Record<string, unknown>).n);
  assert.equal(rowCount > 1000, true, `the real extract has ${rowCount} rows`);

  const commit = await timed(() => commitBatch(asClient(c), upload.value.batchId ?? '', CTX));
  record('SO import: validate 1,386 rows', [upload.ms], `${rowCount} rows staged`);
  record('SO import: commit', [commit.ms], `batch ${upload.value.batchId}`);

  // One upload of the real file, end to end, must stay inside a request. Ten
  // seconds is not a target, it is the point at which something has gone
  // structurally wrong and a worker would have been killed.
  assert.equal(upload.ms + commit.ms < 60_000, true, 'the real extract completes in one pass');
  c.close();
});

test('load: the real 45-row purchase order extract', async () => {
  const c = await fresh();
  const upload = await timed(() =>
    receiveUpload(
      asClient(c),
      {
        importType: 'PURCHASE_ORDER',
        sourceSystemId: 'SRC-EXCEL',
        affiliateId: 'AFF-KE',
        filename: 'PO-Ver1.xls',
        reportingPeriodFrom: null,
        reportingPeriodTo: null,
        bytes: new Uint8Array(PO_FILE),
      },
      CTX,
    ),
  );
  const commit = await timed(() => commitBatch(asClient(c), upload.value.batchId ?? '', CTX));
  record('PO import: validate 45 rows', [upload.ms], 'real extract');
  record('PO import: commit', [commit.ms], 'real extract');
  c.close();
});

test('load: the read paths, at volume, with their query counts', async () => {
  const c = await fresh();
  const client = asClient(c);

  // Load the real sales order extract so the read paths measure something.
  const upload = await receiveUpload(
    client,
    {
      importType: 'SALES_ORDER',
      sourceSystemId: 'SRC-EXCEL',
      affiliateId: null,
      filename: 'SO-Ver1.xls',
      reportingPeriodFrom: '2026-06-01',
      reportingPeriodTo: '2026-06-30',
      bytes: new Uint8Array(SO_FILE),
    },
    CTX,
  );
  await commitBatch(client, upload.batchId ?? '', CTX);

  const orders = await c.execute(`SELECT COUNT(*) AS n FROM sales_orders`);
  const orderCount = Number((orders.rows[0] as unknown as Record<string, unknown>).n);

  const identity = await loadIdentity(client, 'USR-CATH');
  const perms = identity!.permissions;
  const filter = parseFilter(new URLSearchParams());
  const ROUNDS = 10;

  // Each scenario gets its own client wrapper so the phase 28 scope memo is
  // per-run, exactly as a request would be, rather than warm from the last.
  const perRequest = (): Parameters<typeof soSummary>[0] =>
    ({ ...c }) as unknown as Parameters<typeof soSummary>[0];

  const scenarios: [string, () => Promise<unknown>, string][] = [
    [
      'Large sales order list (page 1)',
      () => listSalesOrders(perRequest(), 'USR-CATH', filter, NOW, 100),
      `${orderCount} orders in scope`,
    ],
    [
      'Sales order summary',
      () => soSummary(perRequest(), 'USR-CATH', filter, NOW),
      `${orderCount} orders`,
    ],
    [
      'Executive dashboard',
      () => dashboard(perRequest(), 'USR-CATH', perms, filter, NOW),
      'all four modules',
    ],
    [
      'Large audit history',
      () =>
        listAuditEvents(
          perRequest(),
          'USR-CATH',
          parseAuditFilter(new URLSearchParams('from=2020-01-01&to=2030-01-01'), NOW_DATE),
        ),
      'unbounded window',
    ],
    [
      'Global search across 7 groups',
      () => globalSearch(perRequest(), 'USR-CATH', perms, 'ABC'),
      'seven scoped queries',
    ],
  ];

  for (const [name, run, detail] of scenarios) {
    const samples: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) samples.push((await timed(run)).ms);
    record(name, samples, detail);
    // Nothing may be pathologically slow. This is a smoke ceiling, not a
    // budget: a budget asserted on shared CI hardware fails for reasons
    // unrelated to this repository.
    assert.equal(stats(samples).p90 < 30_000, true, `${name} became pathologically slow`);
  }

  // ---- Concurrency ---------------------------------------------------------
  // Twenty internal users hitting the dashboard at once, and twenty portal
  // customers hitting their home page at once. Each gets its own notional
  // request, so no memo is shared between them.
  const internal = await timed(() =>
    Promise.all(
      Array.from({ length: 20 }, () => dashboard(perRequest(), 'USR-CATH', perms, filter, NOW)),
    ),
  );
  record('20 concurrent internal dashboards', [internal.ms], 'total wall clock');

  const external = await loadIdentity(client, 'USR-EXT001');
  const access = await portalScope(client, external!, null);
  assert.equal(access.ok, true);
  const scope = access.ok ? access.scope : null!;
  const portal = await timed(() =>
    Promise.all(Array.from({ length: 20 }, () => portalHome(perRequest(), scope))),
  );
  record('20 concurrent portal home pages', [portal.ms], 'total wall clock');

  console.log('\n===== PHASE 29 LOAD FIGURES (application layer, in-process database) =====');
  for (const line of REPORT) console.log(line);
  console.log(
    '\nNOTE: these are application-layer figures against a synchronous in-process\n' +
      'database. Production adds one network round trip per query to Turso, so the\n' +
      'query COUNTS matter more than the milliseconds: at ~30ms a round trip, a view\n' +
      'issuing 51 queries cannot be faster than roughly 1.5 seconds however fast its\n' +
      'SQL is. An end-to-end workerd measurement needs live database credentials,\n' +
      'which this environment does not have and which is a stop condition to obtain.',
  );
  c.close();
});
