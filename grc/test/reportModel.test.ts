/**
 * The report model: the pure filters and figures behind the four board reports.
 * The module under test imports only types, so node strips them and runs it
 * directly. These pin the source's aggregation: the risk normalisation, the
 * defaults and UNIT_MANAGER scoping, the implementation rate and its colour, the
 * risk and by-affiliate/by-area rollups, and the overdue and at-risk sets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ActionPlan,
  Observation,
  ReportDataset,
} from '../../src/lib/grc/reports/reportTypes.ts';
import {
  buildReport,
  parseReportFilters,
  normaliseRisk,
  implementationTone,
  isPlanOverdue,
  daysOverdue,
  applyModelFilters,
  defaultDateRange,
  splitRecommendations,
} from '../../src/lib/grc/reports/reportModel.ts';

const NOW = new Date('2026-07-04T00:00:00Z');

function obs(p: Partial<Observation> & { id: string }): Observation {
  return {
    reference: p.id,
    riskRating: null,
    observationTitle: 'Obs',
    observationDescription: null,
    affiliateCode: null,
    affiliateName: null,
    auditAreaName: null,
    status: 'Approved',
    responseStatus: 'Not sent',
    recommendation: null,
    workPaperDate: null,
    year: 2026,
    implications: null,
    responsibility: null,
    managementResponse: null,
    ...p,
  };
}

function plan(p: Partial<ActionPlan> & { id: string }): ActionPlan {
  return {
    actionNumber: p.id,
    workPaperId: null,
    description: 'Do the thing',
    ownerNames: 'Owner',
    dueDate: null,
    status: 'Pending',
    implementationNotes: null,
    observationTitle: null,
    observationReference: null,
    observationRisk: null,
    observationAffiliate: null,
    observationAuditArea: null,
    observationStatus: null,
    ...p,
  };
}

function fixture(): ReportDataset {
  const observations: Observation[] = [
    obs({
      id: 'o1',
      riskRating: 'CRITICAL',
      affiliateName: 'Alpha',
      affiliateCode: 'A1',
      auditAreaName: 'Finance',
      workPaperDate: '2026-06-01',
    }),
    obs({
      id: 'o2',
      riskRating: 'HIGH',
      affiliateName: 'Alpha',
      affiliateCode: 'A1',
      auditAreaName: 'Ops',
      status: 'Sent to Auditee',
      workPaperDate: '2026-05-01',
    }),
    obs({
      id: 'o3',
      riskRating: 'MEDIUM',
      affiliateName: 'Beta',
      affiliateCode: 'B1',
      auditAreaName: 'Finance',
      workPaperDate: '2026-04-01',
    }),
    obs({
      id: 'o4',
      riskRating: 'LOW',
      affiliateName: 'Beta',
      affiliateCode: 'B1',
      auditAreaName: 'Ops',
      workPaperDate: '2026-03-01',
    }),
  ];
  const actionPlans: ActionPlan[] = [
    plan({
      id: 'ap1',
      workPaperId: 'o1',
      status: 'Verified',
      dueDate: '2026-06-10',
      observationRisk: 'CRITICAL',
      observationAffiliate: 'Alpha',
      observationAuditArea: 'Finance',
    }),
    plan({
      id: 'ap2',
      workPaperId: 'o1',
      status: 'In Progress',
      dueDate: '2026-06-20',
      observationRisk: 'CRITICAL',
      observationAffiliate: 'Alpha',
      observationAuditArea: 'Finance',
    }),
    plan({
      id: 'ap3',
      workPaperId: 'o2',
      status: 'Implemented',
      dueDate: '2026-07-01',
      observationRisk: 'HIGH',
      observationAffiliate: 'Alpha',
      observationAuditArea: 'Ops',
    }),
    plan({
      id: 'ap4',
      workPaperId: 'o3',
      status: 'Pending',
      dueDate: '2026-07-10',
      observationRisk: 'MEDIUM',
      observationAffiliate: 'Beta',
      observationAuditArea: 'Finance',
    }),
    plan({
      id: 'ap5',
      workPaperId: 'o4',
      status: 'Closed',
      dueDate: '2026-05-01',
      observationRisk: 'LOW',
      observationAffiliate: 'Beta',
      observationAuditArea: 'Ops',
    }),
  ];
  return { observations, actionPlans };
}

const execFilters = {
  year: null,
  dateFrom: '2026-01-01',
  dateTo: '2026-07-04',
  affiliateCode: null,
  auditAreaId: null,
  risks: ['EXTREME', 'HIGH', 'MEDIUM', 'LOW'] as const,
  statuses: ['Approved', 'Sent to Auditee', 'Submitted', 'Draft'],
  overdueOnly: false,
  reportType: 'executive' as const,
};

const header = {
  organisation: 'Hass Petroleum Group',
  documentTitle: 'Internal Audit Report',
  reportLabel: 'Executive Summary',
  generatedAt: '2026-07-04',
  filterSummary: 'Year: All years',
};

test('normaliseRisk maps CRITICAL and EXTREME into the Extreme bucket', () => {
  assert.equal(normaliseRisk('CRITICAL'), 'EXTREME');
  assert.equal(normaliseRisk('extreme'), 'EXTREME');
  assert.equal(normaliseRisk('High'), 'HIGH');
  assert.equal(normaliseRisk('Moderate'), 'MEDIUM');
  assert.equal(normaliseRisk('unknown'), null);
  assert.equal(normaliseRisk(null), null);
});

test('implementation rate colour: green >=70, amber >=40, else red', () => {
  assert.equal(implementationTone(70), 'good');
  assert.equal(implementationTone(69), 'warn');
  assert.equal(implementationTone(40), 'warn');
  assert.equal(implementationTone(39), 'bad');
});

test('a plan overdue: past due and not settled; a verified plan is not overdue', () => {
  assert.equal(isPlanOverdue({ dueDate: '2026-06-20', status: 'In Progress' }, NOW), true);
  assert.equal(isPlanOverdue({ dueDate: '2026-06-10', status: 'Verified' }, NOW), false);
  assert.equal(isPlanOverdue({ dueDate: '2026-08-01', status: 'Pending' }, NOW), false);
  assert.equal(daysOverdue({ dueDate: '2026-06-20', status: 'In Progress' }, NOW), 14);
});

test('executive summary KPIs: totals, 60% implementation rate (warn), 1 overdue', () => {
  const doc = buildReport(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks] },
    { header, now: NOW },
  );
  // The report opens with the introduction, so the summary is found by kind.
  const kpis = doc.blocks.find((b) => b.kind === 'kpis');
  assert.ok(kpis && kpis.kind === 'kpis');
  if (kpis.kind !== 'kpis') return;
  assert.equal(kpis.items[0].value, '4'); // observations
  assert.equal(kpis.items[1].value, '2'); // high and extreme risk (CRITICAL + HIGH)
  assert.equal(kpis.items[2].value, '5'); // action plans
  assert.equal(kpis.items[3].value, '60%');
  assert.equal(kpis.items[3].tone, 'warn');
  assert.equal(kpis.items[4].value, '1'); // overdue
  assert.equal(kpis.items[4].tone, 'bad');
});

test('risk distribution counts each bucket once at 25%', () => {
  const doc = buildReport(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks] },
    { header, now: NOW },
  );
  const dist = doc.blocks.find((b) => b.kind === 'table' && b.title === 'Risk distribution');
  assert.ok(dist && dist.kind === 'table');
  if (dist.kind !== 'table') return;
  // Extreme row: label, count 1, 25%.
  assert.equal(dist.rows[0][1].text, '1');
  assert.equal(dist.rows[0][2].text, '25%');
});

test('by affiliate: Alpha has 2 obs, 3 plans, 2 implemented, 1 overdue, 67%', () => {
  const doc = buildReport(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks] },
    { header, now: NOW },
  );
  const block = doc.blocks.find((b) => b.kind === 'table' && b.title === 'By affiliate');
  assert.ok(block && block.kind === 'table');
  if (!block || block.kind !== 'table') return;
  const alpha = block.rows.find((r) => r[0].text === 'Alpha');
  assert.ok(alpha);
  assert.deepEqual(
    alpha?.slice(1).map((c) => c.text),
    ['2', '3', '2', '1', '67%'],
  );
});

test('by audit area: Finance 33% (bad), Ops 100% (good)', () => {
  const doc = buildReport(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks] },
    { header, now: NOW },
  );
  const block = doc.blocks.find((b) => b.kind === 'table' && b.title === 'By audit area');
  assert.ok(block && block.kind === 'table');
  if (!block || block.kind !== 'table') return;
  const finance = block.rows.find((r) => r[0].text === 'Finance');
  const ops = block.rows.find((r) => r[0].text === 'Ops');
  assert.equal(finance?.[3].text, '33%');
  assert.equal(finance?.[3].tone, 'bad');
  assert.equal(ops?.[3].text, '100%');
  assert.equal(ops?.[3].tone, 'good');
});

test('overdue report: 1 overdue, 1 at-risk within 14 days, average 14 days', () => {
  const doc = buildReport(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks], reportType: 'overdue' },
    { header, now: NOW },
  );
  // The overdue body follows the shared introduction and executive summary, so
  // its own KPI block is the last one in the document.
  const kpiBlocks = doc.blocks.filter((b) => b.kind === 'kpis');
  const kpis = kpiBlocks[kpiBlocks.length - 1];
  assert.ok(kpis && kpis.kind === 'kpis');
  if (kpis.kind !== 'kpis') return;
  assert.equal(kpis.items[0].value, '1'); // total overdue
  assert.equal(kpis.items[1].value, '1'); // at risk
  assert.equal(kpis.items[2].value, '14'); // average days overdue
  const overdueTable = doc.blocks.find((b) => b.kind === 'table' && b.rows.length === 1);
  assert.ok(overdueTable && overdueTable.kind === 'table');
});

test('overdue-only filter keeps only observations with an overdue plan', () => {
  const filtered = applyModelFilters(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks], overdueOnly: true },
    NOW,
  );
  assert.equal(filtered.actionPlans.length, 1);
  assert.equal(filtered.actionPlans[0].id, 'ap2');
  assert.deepEqual(
    filtered.observations.map((o) => o.id),
    ['o1'],
  );
});

test('default filters: all risks and statuses on, six-month range, executive type', () => {
  const f = parseReportFilters(
    new URLSearchParams(''),
    { roleCode: 'SENIOR_AUDITOR', isPlatformOwner: false },
    NOW,
  );
  assert.equal(f.risks.length, 4);
  assert.equal(f.statuses.length, 4);
  assert.equal(f.reportType, 'executive');
  assert.equal(f.dateTo, '2026-07-04');
  assert.equal(f.dateFrom, defaultDateRange(NOW).from);
});

test('UNIT_MANAGER scoping: no Draft or Submitted, affiliate forced', () => {
  const params = new URLSearchParams('applied=1&affiliate=OTHER&status=Draft&status=Approved');
  const f = parseReportFilters(
    params,
    { roleCode: 'UNIT_MANAGER', isPlatformOwner: false, forcedAffiliateCode: 'MINE' },
    NOW,
  );
  assert.equal(f.affiliateCode, 'MINE');
  assert.ok(!f.statuses.includes('Draft'));
  assert.ok(!f.statuses.includes('Submitted'));
  assert.deepEqual(f.statuses, ['Approved']);
});

// ---- The house structure and the added report types ------------------------

function build(reportType: string) {
  return buildReport(
    fixture(),
    { ...execFilters, risks: [...execFilters.risks], reportType: reportType as 'executive' },
    { header, now: NOW },
  );
}
const headings = (doc: ReturnType<typeof build>): string[] =>
  doc.blocks.filter((b) => b.kind === 'heading').map((b) => (b.kind === 'heading' ? b.text : ''));

test('every report opens in the house structure: introduction, executive summary, review summary', () => {
  for (const type of ['executive', 'barc', 'observations', 'trend', 'tracker', 'overdue']) {
    const h = headings(build(type));
    assert.ok(h[0]?.startsWith('1. Introduction'), `${type} must open with the introduction`);
    assert.ok(
      h.some((t) => t.startsWith('2. Executive summary')),
      `${type} must carry an executive summary`,
    );
    assert.ok(
      h.some((t) => t.startsWith('3. Review summary')),
      `${type} must carry a review summary`,
    );
  }
});

test('the narrative reports carry detailed observations and an appendix', () => {
  for (const type of ['executive', 'barc', 'observations']) {
    const h = headings(build(type));
    assert.ok(
      h.some((t) => t.startsWith('5. Detailed observations')),
      `${type} must carry the detailed observations`,
    );
    assert.ok(
      h.some((t) => t.startsWith('Appendix A')),
      `${type} must carry the appendix`,
    );
  }
});

test('the BARC pack leads on the portfolio across affiliates', () => {
  const doc = build('barc');
  assert.ok(headings(doc).some((t) => t.startsWith('4. Portfolio position')));
  const kpiBlocks = doc.blocks.filter((b) => b.kind === 'kpis');
  // The shared executive summary, then the pack's own portfolio KPIs.
  assert.ok(kpiBlocks.length >= 2);
  const portfolio = kpiBlocks[1];
  assert.ok(portfolio.kind === 'kpis');
  if (portfolio.kind !== 'kpis') return;
  assert.equal(portfolio.items[0].label, 'Affiliates covered');
  assert.equal(portfolio.items[0].value, '2'); // Alpha and Beta
  assert.ok(doc.blocks.some((b) => b.kind === 'table' && b.title === 'By affiliate'));
});

test('the trend report buckets observations by quarter, oldest first', () => {
  const doc = build('trend');
  const table = doc.blocks.find((b) => b.kind === 'table' && b.title?.startsWith('By period'));
  assert.ok(table && table.kind === 'table');
  if (!table || table.kind !== 'table') return;
  // The fixture spans March to June 2026, so Q1 and Q2, oldest first.
  assert.deepEqual(
    table.rows.map((r) => r[0].text),
    ['2026 Q1', '2026 Q2'],
  );
  // Q1 holds o4 (March); Q2 holds o3 (April), o2 (May) and o1 (June).
  assert.equal(table.rows[0][1].text, '1');
  assert.equal(table.rows[1][1].text, '3');
});

test('an observation section carries its evidence table and numbered recommendations', () => {
  const data = fixture();
  data.observations[0].recommendation =
    '1. Reconcile monthly. 2. Have the reconciliation reviewed.';
  data.observations[0].implications = 'Unreconciled balances may hide misstatement.';
  const doc = buildReport(
    data,
    { ...execFilters, risks: [...execFilters.risks], reportType: 'observations' },
    { header, now: NOW },
  );
  const evidence = doc.blocks.find((b) => b.kind === 'table' && b.title === 'Evidence');
  assert.ok(evidence && evidence.kind === 'table');
  const list = doc.blocks.find((b) => b.kind === 'list');
  assert.ok(list && list.kind === 'list');
  if (!list || list.kind !== 'list') return;
  assert.deepEqual(list.items, ['Reconcile monthly.', 'Have the reconciliation reviewed.']);
  assert.equal(list.ordered, true);
  // The implications belong to the analytical narrative, not a table.
  assert.ok(
    doc.blocks.some((b) => b.kind === 'narrative' && b.text.includes('may hide misstatement')),
  );
});

test('the appendix carries the management response recorded for each observation', () => {
  const data = fixture();
  data.observations[0].managementResponse = 'Agreed, remediation begins in August.';
  const doc = buildReport(
    data,
    { ...execFilters, risks: [...execFilters.risks], reportType: 'observations' },
    { header, now: NOW },
  );
  assert.ok(
    doc.blocks.some(
      (b) =>
        b.kind === 'narrative' &&
        b.text === 'Management response: Agreed, remediation begins in August.',
    ),
  );
  // An observation with none recorded says so rather than going silent.
  assert.ok(
    doc.blocks.some(
      (b) => b.kind === 'narrative' && b.text === 'Management response: none recorded.',
    ),
  );
});

test('recommendations split on numbering or newlines, and survive a single sentence', () => {
  assert.deepEqual(splitRecommendations('1. First point 2. Second point'), [
    'First point',
    'Second point',
  ]);
  assert.deepEqual(splitRecommendations('First line\nSecond line'), ['First line', 'Second line']);
  assert.deepEqual(splitRecommendations('(1) Alpha (2) Beta'), ['Alpha', 'Beta']);
  assert.deepEqual(splitRecommendations('Just the one recommendation.'), [
    'Just the one recommendation.',
  ]);
  assert.deepEqual(splitRecommendations(null), []);
  assert.deepEqual(splitRecommendations('   '), []);
});

test('an empty scope still produces a readable report rather than an empty page', () => {
  const doc = buildReport(
    { observations: [], actionPlans: [] },
    { ...execFilters, risks: [...execFilters.risks], reportType: 'executive' },
    { header, now: NOW },
  );
  assert.ok(headings(doc).some((t) => t.startsWith('1. Introduction')));
  assert.ok(
    doc.blocks.some((b) => b.kind === 'note' && b.text.includes('No observations')),
    'the observations section states the scope is empty',
  );
});
