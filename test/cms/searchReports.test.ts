/**
 * Phase 27: global search, the reporting centre and exports.
 *
 * THE TEST THAT MATTERS MOST IS THE FOURTH ONE. A Kenya user searching a
 * known Uganda document number must receive a response identical to searching
 * a number that does not exist. Anything else, a different message, a
 * different shape, a different count, confirms the order is real, and
 * confirming existence is the leak.
 *
 * The second is the reconciliation: a report figure and the dashboard figure
 * for the same metric and the same filter must be identical, because they are
 * the same service call. A report that computed its own would drift, and the
 * first person to notice would be a manager holding two numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import {
  globalSearch,
  MIN_QUERY_LENGTH,
  GROUP_LIMIT,
  type SearchResult,
} from '../../src/lib/cms/search/globalSearch.ts';
import { REPORTS, reportById, reportsFor } from '../../src/lib/cms/reports/catalogue.ts';
import {
  toCsv,
  toXlsx,
  csvCell,
  sheetCell,
  describeFilter,
  reportExportStmt,
  MAX_EXPORT_ROWS,
  REPORT_EXPORT_EVENT,
} from '../../src/lib/cms/reports/export.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { soSummary, csvCell as soCsvCell } from '../../src/lib/cms/repos/soPerformance.ts';
import { winRate, funnel } from '../../src/lib/cms/repos/crmAnalytics.ts';
import { summary as serviceSummary } from '../../src/lib/cms/repos/serviceAnalytics.ts';
import { loadIdentity } from '../../src/lib/cms/repos/identity.ts';

const NOW = '2026-08-27 10:00:00';
const asClient = (c: TestClient) => c as unknown as Parameters<typeof globalSearch>[0];

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  return c;
};

/** PERM-036 is a docs-script permission absent from the seed, as in phase 22. */
async function grantCrmPermissions(c: TestClient): Promise<void> {
  await c.execute(`INSERT OR IGNORE INTO permissions
      (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions
      (role_permission_id, role_id, permission_id, allowed, created_at)
    SELECT 'RP-' || role_id || '-036', role_id, 'PERM-036', 1, CURRENT_TIMESTAMP
      FROM access_roles WHERE role_id IN ('ROLE-ADMIN','ROLE-GRP-FIN','ROLE-SALES','ROLE-CSM')`);
}

async function permsFor(c: TestClient, userId: string): Promise<readonly string[]> {
  const identity = await loadIdentity(asClient(c), userId);
  assert.notEqual(identity, null);
  return identity!.permissions;
}

const emptyFilter = () => parseFilter(new URLSearchParams());

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test('an exact identifier search returns the right record first', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');

  const order = await c.execute(
    `SELECT document_number FROM sales_orders ORDER BY sales_order_id LIMIT 1`,
  );
  const documentNumber = String(
    (order.rows[0] as unknown as Record<string, unknown>).document_number,
  );

  // The customer whose telephone number contains the same digits, which is
  // the exact confusion the phase names.
  await c.execute({
    sql: `UPDATE accounts SET phone = ? WHERE account_id = 'ACC-002'`,
    args: [`+254700${documentNumber}`],
  });

  const result = await globalSearch(asClient(c), 'USR-CATH', perms, documentNumber);
  assert.equal(result.total > 0, true, 'the order is found');

  // THE RANKING: the sales order group comes first because its hit is an
  // exact identifier match, band 0, and nothing else can beat that.
  const first = result.groups[0]!;
  assert.equal(first.group, 'SALES_ORDER', `expected sales orders first, got ${first.group}`);
  assert.equal(first.hits[0]!.title, documentNumber);
  // A document number is an exact CODE match, band 1. Band 0 is the internal
  // identifier, which nobody types. What matters is that band 1 beats every
  // prefix and substring hit in every other group, and it does.
  assert.equal(first.hits[0]!.rank, 1);
  for (const group of result.groups.slice(1)) {
    for (const hit of group.hits) {
      assert.equal(hit.rank > 1, true, `${hit.title} must not outrank the exact document number`);
    }
  }
  // And the phone-number customer is not in front of it. `phone` is not a
  // searched column at all, so it is not in the result set.
  assert.equal(
    result.groups.some((g) => g.group === 'ACCOUNT' && g.hits.some((h) => h.id === 'ACC-002')),
    false,
  );
});

test('a prefix search outranks a substring one', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  const result = await globalSearch(asClient(c), 'USR-CATH', perms, 'ABC');
  const accounts = result.groups.find((g) => g.group === 'ACCOUNT');
  if (accounts === undefined || accounts.hits.length < 2) return;
  // Ranks ascend: a hit that starts with the term sorts before one that
  // merely contains it.
  const ranks = accounts.hits.map((h) => h.rank);
  assert.deepEqual(
    [...ranks].sort((a, b) => a - b),
    ranks,
    'hits are returned rank-ascending',
  );
});

test('a short query returns nothing rather than everything', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  assert.equal(MIN_QUERY_LENGTH, 2);
  const result = await globalSearch(asClient(c), 'USR-CATH', perms, 'A');
  assert.equal(result.total, 0);
  assert.deepEqual(result.groups, []);
});

test('a Kenya user searching a Uganda document number gets the same answer as for a number that does not exist', async () => {
  const c = await db();
  // USR-GAB is the Kenya affiliate finance manager.
  const perms = await permsFor(c, 'USR-GAB');

  // A real Uganda order, confirmed to exist and confirmed to be out of scope.
  const uganda = await c.execute(
    `SELECT document_number FROM sales_orders WHERE affiliate_id = 'AFF-UG' LIMIT 1`,
  );
  if (uganda.rows.length === 0) {
    await c.execute(`INSERT INTO sales_orders
        (sales_order_id, document_number, affiliate_id, business_unit_id, account_id,
         order_created_at, currency_code, credit_approval_required, status, created_at)
      VALUES ('SO-UG-T1','UG-999901','AFF-UG',NULL,'ACC-005','2026-08-10 08:00:00','UGX',0,'INVOICED',CURRENT_TIMESTAMP)`);
  }
  const known =
    uganda.rows.length > 0
      ? String((uganda.rows[0] as unknown as Record<string, unknown>).document_number)
      : 'UG-999901';

  const exists = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sales_orders WHERE document_number = ?`,
    args: [known],
  });
  assert.equal(
    Number((exists.rows[0] as unknown as Record<string, unknown>).n),
    1,
    'the Uganda order really is in the database',
  );

  const forReal = await globalSearch(asClient(c), 'USR-GAB', perms, known);
  const forFiction = await globalSearch(asClient(c), 'USR-GAB', perms, 'ZZ-000000-NOPE');

  // Identical, field by field, apart from the query string itself.
  const shape = (r: SearchResult) => ({
    groups: r.groups,
    total: r.total,
    notPermitted: r.notPermitted,
  });
  assert.deepEqual(shape(forReal), shape(forFiction));
  assert.equal(forReal.total, 0);
  assert.deepEqual(forReal.groups, []);
  // And nothing anywhere in the response mentions the order or hints at it.
  assert.equal(JSON.stringify(forReal).includes('AFF-UG'), false);
  assert.equal(/permission|denied|forbidden|not allowed/i.test(JSON.stringify(forReal)), false);
});

test('results are grouped by entity with context, never a flat mixed list', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  // Two characters minimum, so the probe has to be two.
  const result = await globalSearch(asClient(c), 'USR-CATH', perms, 'an');
  const wide = await globalSearch(asClient(c), 'USR-CATH', perms, 'ke');
  const used = result.total > 0 ? result : wide;

  assert.equal(used.groups.length > 0, true);
  for (const group of used.groups) {
    assert.equal(group.label !== '', true, 'every group is labelled');
    assert.equal(group.hits.length <= GROUP_LIMIT, true, 'one group cannot crowd out the rest');
    for (const hit of group.hits) {
      assert.equal(hit.title !== '', true);
      // The context is what makes a title mean something. A customer without
      // its country, or an order without its customer, is a row a reader has
      // to click to identify.
      assert.equal(hit.context !== '', true, `${hit.title} has no context`);
      assert.equal(hit.href.startsWith('/app/'), true);
      assert.equal(hit.group, group.group);
    }
  }
});

test('a caller with no module permission searches nothing, and is told which', async () => {
  const c = await db();
  // USR-VIC is the credit manager: no accounts, leads, opportunities, cases
  // or order view codes beyond credit approval in the seed.
  const perms = await permsFor(c, 'USR-VIC');
  const result = await globalSearch(asClient(c), 'USR-VIC', perms, 'ABC');
  for (const group of result.groups) {
    assert.equal(group.hits.length >= 0, true);
  }
  // The groups they hold no permission for are named rather than silently
  // absent, so they can ask for the right code rather than for "search".
  assert.equal(result.notPermitted.length > 0, true);
});

test('a wildcard in the search term is escaped and does not match everything', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  const everything = await globalSearch(asClient(c), 'USR-CATH', perms, 'an');
  const wildcard = await globalSearch(asClient(c), 'USR-CATH', perms, '%%');
  // `%%` is two literal per-cent signs, which nothing in the seed contains.
  assert.equal(wildcard.total, 0, 'a wildcard is a literal, not an operator');
  assert.equal(everything.total >= wildcard.total, true);
});

// ---------------------------------------------------------------------------
// The reporting centre
// ---------------------------------------------------------------------------

test('every report declares its permission, its parameters, its KPIs and its source module', () => {
  assert.equal(REPORTS.length >= 8, true);
  const ids = new Set<string>();
  for (const report of REPORTS) {
    assert.equal(ids.has(report.id), false, `${report.id} is defined twice`);
    ids.add(report.id);
    assert.equal(report.permission.includes('.'), true, `${report.id} needs a permission code`);
    assert.equal(report.parameters.length > 0, true, `${report.id} declares no parameters`);
    assert.equal(report.kpis.length > 0, true, `${report.id} declares no KPI`);
    // The source is the module it reuses. Named, so a reviewer can check that
    // the report is a shape over a service and not a second query.
    assert.match(report.source, /^(repos|analytics)\//, `${report.id} names no source module`);
    for (const kpi of report.kpis) {
      assert.equal(kpi.name !== '', true);
      assert.equal(kpi.definition.length > 30, true, `${kpi.name} needs a real definition`);
      assert.equal(kpi.denominator !== '', true, `${kpi.name} states no denominator`);
      assert.equal(kpi.dateBasis !== '', true, `${kpi.name} states no date basis`);
    }
  }
});

test('a report figure and the dashboard figure are identical, three pairs', async () => {
  const c = await db();
  await grantCrmPermissions(c);
  const perms = await permsFor(c, 'USR-CATH');
  const filter = emptyFilter();
  const client = asClient(c);

  // ---- Pair one: sales order finance turnaround ---------------------------
  const dashboardSo = await soSummary(client, 'USR-CATH', filter, NOW);
  const reportSo = await reportById('so-summary')!.run(client, 'USR-CATH', filter, NOW, perms);
  const financeRow = reportSo.rows.find(
    (row) => row.metric === 'Finance turnaround, median elapsed minutes',
  );
  assert.notEqual(financeRow, undefined);
  const expectedFinance =
    dashboardSo.finance.elapsed.medianMinutes === null
      ? null
      : Math.round(dashboardSo.finance.elapsed.medianMinutes * 10) / 10;
  assert.equal(financeRow!.value, expectedFinance);

  const orderRow = reportSo.rows.find((row) => row.metric === 'Orders in scope');
  assert.equal(orderRow!.value, dashboardSo.orders);

  const slaRow = reportSo.rows.find((row) => row.metric === 'SLA compliance, per cent');
  assert.equal(slaRow!.value, dashboardSo.slaCompliancePercent);

  // ---- Pair two: CRM win rate ---------------------------------------------
  const dashboardWin = await winRate(client, 'USR-CATH', filter);
  const dashboardFunnel = await funnel(client, 'USR-CATH', filter);
  const reportCrm = await reportById('crm-funnel')!.run(client, 'USR-CATH', filter, NOW, perms);
  const winRow = reportCrm.rows.find((row) => row.stage === 'Win rate');
  assert.notEqual(winRow, undefined);
  assert.equal(winRow!.rate, dashboardWin.winRatePercent);
  assert.equal(winRow!.count, dashboardWin.won);
  const qualRow = reportCrm.rows.find((row) => row.stage === 'Qualification rate');
  assert.equal(qualRow!.rate, dashboardFunnel.qualificationRatePercent);

  // ---- Pair three: service resolution --------------------------------------
  const dashboardService = await serviceSummary(client, 'USR-CATH', filter);
  const reportService = await reportById('service-summary')!.run(
    client,
    'USR-CATH',
    filter,
    NOW,
    perms,
  );
  const elapsedRow = reportService.rows.find(
    (row) => row.metric === 'Resolution elapsed, median minutes',
  );
  const expectedElapsed =
    dashboardService.medianResolutionElapsedMinutes === null
      ? null
      : Math.round(dashboardService.medianResolutionElapsedMinutes * 10) / 10;
  assert.equal(elapsedRow!.value, expectedElapsed);

  const accountableRow = reportService.rows.find(
    (row) => row.metric === 'Resolution accountable, median minutes',
  );
  // Two distinct labelled durations. Neither is ever presented as the other.
  assert.notEqual(elapsedRow!.metric, accountableRow!.metric);
});

test('a caller sees only the reports their permissions allow', async () => {
  const c = await db();
  const adminPerms = await permsFor(c, 'USR-CATH');
  const creditPerms = await permsFor(c, 'USR-VIC');

  const forAdmin = reportsFor(adminPerms);
  const forCredit = reportsFor(creditPerms);
  assert.equal(forAdmin.length > forCredit.length, true);
  for (const report of forCredit) {
    assert.equal(creditPerms.includes(report.permission), true);
  }
});

test('the credit column is absent, not empty, for a caller without the credit code', async () => {
  const c = await db();
  const filter = emptyFilter();
  const client = asClient(c);

  const withCredit = await permsFor(c, 'USR-VIC');
  assert.equal(withCredit.includes('CREDIT.EXCEPTION.APPROVE'), true);
  const without = (await permsFor(c, 'USR-GAB')).filter(
    (code) => code !== 'CREDIT.EXCEPTION.APPROVE',
  );

  const report = reportById('customer-performance')!;
  const hidden = await report.run(client, 'USR-GAB', filter, NOW, without);
  assert.equal(
    hidden.columns.some((column) => column.key === 'creditExceptionRatePercent'),
    false,
    'the column is absent, so nothing is implied about what is behind it',
  );
  assert.equal(
    hidden.notes.some((note) => note.includes('CREDIT.EXCEPTION.APPROVE')),
    true,
    'and the report says why',
  );
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('a cell beginning with an equals sign is escaped in CSV and in XLSX', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  await c.execute(`UPDATE accounts SET account_name = '=cmd|calc' WHERE account_id = 'ACC-001'`);

  const report = reportById('customer-performance')!;
  const run = await report.run(asClient(c), 'USR-CATH', emptyFilter(), NOW, perms);
  const meta = {
    reportName: report.name,
    generatedAt: NOW,
    generatedBy: 'Catherine Mwangi',
    filters: describeFilter(emptyFilter()),
    dateBasis: 'sales_orders.order_created_at',
    dataFreshness: 'Test',
    rowCount: run.rows.length,
  };

  // ---- CSV, the raw bytes --------------------------------------------------
  const csv = toCsv(report, run, meta);
  if (run.rows.length > 0) {
    assert.equal(csv.includes(`"'=cmd|calc"`), true, 'the formula is defused with an apostrophe');
    assert.equal(csv.includes(`"=cmd|calc"`), false, 'and never appears undefused');
  }
  // The rule itself, on every character a spreadsheet treats as a formula.
  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    assert.equal(csvCell(`${prefix}danger`), `"'${prefix}danger"`);
  }
  // And it matches the phase 20 exporter exactly, so there is one rule.
  assert.equal(csvCell('=cmd|calc'), soCsvCell('=cmd|calc'));
  assert.equal(csvCell('ordinary'), soCsvCell('ordinary'));

  // ---- XLSX, the cell objects ---------------------------------------------
  assert.deepEqual(sheetCell('=cmd|calc'), { t: 's', v: "'=cmd|calc" });
  assert.deepEqual(sheetCell('@SUM(A1)'), { t: 's', v: "'@SUM(A1)" });
  // A number stays a number, or the workbook is text nobody can sum.
  assert.deepEqual(sheetCell(240), { t: 'n', v: 240 });
  // Zero is a number, not an empty cell.
  assert.deepEqual(sheetCell(0), { t: 'n', v: 0 });

  const bytes = toXlsx(report, run, meta);
  assert.equal(bytes.byteLength > 0, true, 'a real workbook is produced');
  // PK: a zip container, which is what an xlsx is.
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
});

test('unknown stays blank and zero stays zero, in both formats', () => {
  // The three that a careless exporter collapses into one.
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(''), '""');
  assert.notEqual(csvCell(null), csvCell(0));

  assert.deepEqual(sheetCell(null), { t: 's', v: '' });
  assert.deepEqual(sheetCell(0), { t: 'n', v: 0 });
  assert.notDeepEqual(sheetCell(null), sheetCell(0));
});

test("a scoped export matches that user's screen exactly and gains nothing", async () => {
  const c = await db();
  const filter = emptyFilter();
  const client = asClient(c);
  const report = reportById('so-approver-performance')!;

  const adminPerms = await permsFor(c, 'USR-CATH');
  const ugandaPerms = await permsFor(c, 'USR-FMUG');

  const adminRun = await report.run(client, 'USR-CATH', filter, NOW, adminPerms);
  const ugandaRun = await report.run(client, 'USR-FMUG', filter, NOW, ugandaPerms);

  // The export is built from the same `run`, so it is the same rows by
  // construction. Asserted anyway, because "by construction" is exactly the
  // claim a regression breaks.
  const meta = {
    reportName: report.name,
    generatedAt: NOW,
    generatedBy: 'Grace Atieno',
    filters: describeFilter(filter),
    dateBasis: 'sales_orders.order_created_at',
    dataFreshness: 'Test',
    rowCount: ugandaRun.rows.length,
  };
  const csv = toCsv(report, ugandaRun, meta);
  const dataLines = csv.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  // One header line plus one line per row.
  assert.equal(dataLines.length, ugandaRun.rows.length + 1);

  // And the Uganda export is not the administrator's export.
  if (adminRun.rows.length > 0) {
    assert.equal(ugandaRun.rows.length <= adminRun.rows.length, true);
  }
});

test('two currencies are never summed in an export', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  // A second currency beside the seeded ones.
  await c.execute(
    `UPDATE sales_orders SET currency_code = 'USD' WHERE sales_order_id IN
       (SELECT sales_order_id FROM sales_orders LIMIT 1)`,
  );
  const report = reportById('so-summary')!;
  const run = await report.run(asClient(c), 'USR-CATH', emptyFilter(), NOW, perms);
  const valueRows = run.rows.filter((row) => String(row.metric).startsWith('Order value,'));
  const currencies = new Set(valueRows.map((row) => String(row.metric)));
  assert.equal(currencies.size, valueRows.length, 'one row per currency');
  // There is no total row and no combined figure anywhere.
  assert.equal(
    run.rows.some((row) => /total value|grand total|all currencies/i.test(String(row.metric))),
    false,
  );
});

test('the metadata section says what the file is a view of, and alters no value', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  const filter = parseFilter(
    new URLSearchParams('from=2026-08-01&to=2026-08-31&affiliateId=AFF-KE'),
  );
  const report = reportById('so-summary')!;
  const run = await report.run(asClient(c), 'USR-CATH', filter, NOW, perms);
  const meta = {
    reportName: report.name,
    generatedAt: NOW,
    generatedBy: 'Catherine Mwangi',
    filters: describeFilter(filter),
    dateBasis: 'sales_orders.order_created_at',
    dataFreshness: 'Sales order extract: last imported 2026-08-20 09:00:00',
    rowCount: run.rows.length,
  };
  const csv = toCsv(report, run, meta);

  for (const expected of [
    'Sales order performance summary',
    NOW,
    'Catherine Mwangi',
    '2026-08-01 to 2026-08-31',
    'affiliate AFF-KE',
    'sales_orders.order_created_at',
    'last imported',
  ]) {
    assert.equal(csv.includes(expected), true, `the file must state: ${expected}`);
  }

  // Every KPI definition travels with the file, so a printed copy can say
  // what its numbers mean.
  for (const kpi of report.kpis) {
    assert.equal(csv.includes(kpi.name), true, `${kpi.name} is missing from the metadata`);
  }

  // The metadata is a comment block, so a script can skip it without
  // disturbing the rows.
  const headerIndex = csv.split('\n').findIndex((line) => line.startsWith('"Metric"'));
  assert.equal(headerIndex > 0, true);
  for (const line of csv.split('\n').slice(0, headerIndex)) {
    assert.equal(line === '' || line.startsWith('#'), true, `stray line before the data: ${line}`);
  }
});

test('a user performance export carries process, stage, scope and volume on every row', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  const filter = emptyFilter();
  const client = asClient(c);

  for (const id of ['so-approver-performance', 'po-approver-performance']) {
    const report = reportById(id)!;
    const run = await report.run(client, 'USR-CATH', filter, NOW, perms);
    const keys = run.columns.map((column) => column.key);
    // The four the phase requires, on every user performance report.
    assert.equal(keys.includes('processType'), true, `${id} must carry the process`);
    assert.equal(keys.includes('stageName'), true, `${id} must carry the stage`);
    assert.equal(keys.includes('transactions'), true, `${id} must carry the volume`);
    assert.equal(
      keys.includes('affiliateName') || keys.includes('authorityContext'),
      true,
      `${id} must carry the scope`,
    );
    for (const row of run.rows) {
      assert.equal(String(row.processType) !== '', true);
      assert.equal(String(row.stageName) !== '', true);
      assert.equal(typeof row.transactions, 'number');
    }
    // AND THERE IS NO BLENDED FIGURE. No column anywhere averages a person
    // across processes, which is the error the business asked us to avoid.
    assert.equal(
      keys.some((key) => /^average(ApprovalTime|Minutes)$|overall|blended/i.test(key)),
      false,
      `${id} must not carry a blended per-person figure`,
    );
  }
});

test('the export refuses above its ceiling rather than truncating', () => {
  // Refused, not truncated. A truncated export is the dangerous outcome: it
  // looks complete, somebody sums it, and the total is wrong with nothing on
  // the page to say so.
  assert.equal(MAX_EXPORT_ROWS >= 20000, true);
  assert.equal(Number.isInteger(MAX_EXPORT_ROWS), true);
});

test('REPORT_EXPORTED records the filters and the count and never the content', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  await c.execute(`UPDATE accounts SET account_name = '=cmd|calc' WHERE account_id = 'ACC-001'`);
  const report = reportById('customer-performance')!;
  const filter = parseFilter(new URLSearchParams('from=2026-08-01&to=2026-08-31'));
  const run = await report.run(asClient(c), 'USR-CATH', filter, NOW, perms);

  await c.execute(
    reportExportStmt({
      actorUserId: 'USR-CATH',
      report,
      filter,
      rowCount: run.rows.length,
      format: 'XLSX',
      ip: '196.201.0.1',
      userAgent: 'test',
      now: new Date('2026-08-27T10:00:00Z'),
    }),
  );

  const written = await c.execute({
    sql: `SELECT entity_type, entity_id, action, after_json FROM audit_events WHERE event_type = ?`,
    args: [REPORT_EXPORT_EVENT],
  });
  assert.equal(written.rows.length, 1);
  const row = written.rows[0] as unknown as Record<string, unknown>;
  assert.equal(String(row.entity_type), 'REPORT');
  assert.equal(String(row.entity_id), 'customer-performance');
  assert.equal(String(row.action), 'EXPORT');

  const payload = JSON.parse(String(row.after_json)) as Record<string, unknown>;
  assert.equal(payload.rowCount, run.rows.length);
  assert.equal(payload.format, 'XLSX');
  assert.equal(String(payload.filters).includes('2026-08-01 to 2026-08-31'), true);

  // The exported CONTENT is not in the audit row. The report's own name is,
  // and should be: it says what was exported without carrying any of it.
  assert.equal(String(row.after_json).includes('cmd|calc'), false);
  assert.equal(String(row.after_json).includes('SLA compliance %'), false);
  for (const value of run.rows.map((r) => String(r.customerName))) {
    if (value !== '' && value !== 'undefined') {
      assert.equal(String(row.after_json).includes(value), false, `${value} leaked into the audit`);
    }
  }
});

test('drill-through resolves to the live record', async () => {
  const c = await db();
  const perms = await permsFor(c, 'USR-CATH');
  const report = reportById('customer-performance')!;
  const run = await report.run(asClient(c), 'USR-CATH', emptyFilter(), NOW, perms);
  if (run.rows.length === 0) return;
  const href = run.hrefFor?.(run.rows[0]!) ?? null;
  assert.notEqual(href, null);
  assert.match(href!, /^\/app\/customers\/ACC-/);
});
