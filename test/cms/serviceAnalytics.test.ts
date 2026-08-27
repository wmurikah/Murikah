/**
 * Phase 23: customer service analytics.
 *
 * The things this phase must not do are all forms of quiet dishonesty: a
 * resolution figure that hides what the customer waited, internal delay
 * presented as excusable, a free-text sentence counted as a category, a
 * breach blamed on whoever closed the case, three different survey
 * instruments averaged into one meaningless number, and a missing survey
 * treated as a neutral opinion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { formatDuration, formatRate } from '../../src/lib/cms/analytics/stats.ts';
import {
  summary,
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
  trend,
  insights,
  casePopulation,
  INTERNAL_WAITING_WORDING,
  HIGH_REASSIGNMENT_WORDING,
  REPEAT_WORDING,
  BREACH_ATTRIBUTION_NOTE,
  FEEDBACK_COVERAGE_NOTE,
  NO_DENOMINATOR_NOTE,
} from '../../src/lib/cms/repos/serviceAnalytics.ts';
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
const asClient = (c: TestClient) => c as unknown as Parameters<typeof summary>[0];
const filter = (query = '') => parseFilter(new URLSearchParams(query));

/** A case with a full status history, so its elapsed time can be decomposed. */
async function makeCase(
  c: TestClient,
  input: {
    id: string;
    number: string;
    raisedAt: string;
    firstResponseAt?: string | null;
    resolvedAt?: string | null;
    statuses?: { at: string; to: string }[];
    accountId?: string;
    categoryId?: string;
    caseType?: string;
    teamId?: string | null;
  },
) {
  await c.execute({
    sql: `INSERT INTO service_cases
            (case_id, case_number, account_id, business_unit_id, case_type, case_category_id,
             priority, subject, description, channel, status, assigned_team_id, assigned_user_id,
             raised_at, first_response_at, resolved_at, closed_at, created_by_user_id, created_at)
          VALUES (?, ?, ?, 'BU-CI', ?, ?, 'MEDIUM', 'Test case', 'Test description', 'EMAIL',
                  ?, ?, 'USR-CATH', ?, ?, ?, NULL, 'USR-CATH', CURRENT_TIMESTAMP)`,
    args: [
      input.id,
      input.number,
      input.accountId ?? 'ACC-001',
      input.caseType ?? 'ENQUIRY',
      input.categoryId ?? 'CC-001',
      input.resolvedAt === undefined || input.resolvedAt === null ? 'IN_PROGRESS' : 'RESOLVED',
      input.teamId === undefined ? 'TEAM-CS-KE' : input.teamId,
      input.raisedAt,
      input.firstResponseAt ?? null,
      input.resolvedAt ?? null,
    ],
  });
  for (const [index, status] of (input.statuses ?? []).entries()) {
    await c.execute({
      sql: `INSERT INTO case_status_history
              (case_status_history_id, case_id, from_status, to_status, changed_by_user_id, changed_at, reason)
            VALUES (?, ?, NULL, ?, 'USR-CATH', ?, 'test')`,
      args: [`CSH-${input.id}-${index}`, input.id, status.to, status.at],
    });
  }
}

// ---------------------------------------------------------------------------

test('elapsed and accountable resolution are two labelled figures and differ on a paused case', async () => {
  const c = await db();
  await makeCase(c, {
    id: 'CASE-EL',
    number: 'CASE-9001',
    raisedAt: '2026-08-20 08:00:00',
    firstResponseAt: '2026-08-20 08:30:00',
    resolvedAt: '2026-08-20 14:00:00',
  });
  // The engine recorded two hours paused while the customer was asked for
  // information. The customer still waited six hours.
  await c.execute(`INSERT INTO sla_instances
      (sla_instance_id, sla_rule_id, entity_type, entity_id, workflow_stage_instance_id,
       accountable_user_id, accountable_team_id, started_at, target_at, warning_at, stopped_at,
       paused_minutes, status, breached_at)
    VALUES ('SLAI-EL','SLAR-001','CASE','CASE-EL',NULL,'USR-CATH','TEAM-CS-KE',
            '2026-08-20 08:00:00','2026-08-20 16:00:00','2026-08-20 15:00:00','2026-08-20 14:00:00',
            120,'MET',NULL)`);

  const result = await summary(asClient(c), SEED.admin, filter('from=2026-08-20&to=2026-08-20'));
  assert.equal(result.medianResolutionElapsedMinutes, 360, 'six hours of the customer day');
  assert.equal(
    result.medianResolutionAccountableMinutes,
    240,
    'four hours the organisation is held to, after the recorded pause',
  );
  assert.notEqual(
    result.medianResolutionElapsedMinutes,
    result.medianResolutionAccountableMinutes,
    'the two are never the same figure wearing two labels',
  );
});

test('first response matches the SLA engine figure for the same case', async () => {
  const c = await db();
  const result = await summary(asClient(c), SEED.admin, filter());
  const engine = await c.execute(`
    SELECT SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met,
           SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
    FROM sla_instances si
    JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
    WHERE si.entity_type = 'CASE' AND sr.stage_code = 'FIRST_RESPONSE'`);
  const met = Number(engine.rows[0]?.met ?? 0);
  const breached = Number(engine.rows[0]?.breached ?? 0);
  assert.equal(
    result.firstResponseWithinSlaPercent,
    met + breached === 0 ? null : Math.round((met / (met + breached)) * 1000) / 10,
    'the compliance figure is the engine own, never a second calculation',
  );
  assert.equal(result.firstResponseMeasured + result.awaitingFirstResponse, result.casesOpened);
});

test('the waiting breakdown sums to the elapsed total and excludes incomplete cases', async () => {
  const c = await db();
  // Raised 08:00, resolved 14:00. Two hours in progress, two waiting on the
  // customer, two waiting internally.
  await makeCase(c, {
    id: 'CASE-WB',
    number: 'CASE-9002',
    raisedAt: '2026-08-21 08:00:00',
    resolvedAt: '2026-08-21 14:00:00',
    statuses: [
      { at: '2026-08-21 08:00:00', to: 'IN_PROGRESS' },
      { at: '2026-08-21 10:00:00', to: 'WAITING_CUSTOMER' },
      { at: '2026-08-21 12:00:00', to: 'WAITING_INTERNAL' },
    ],
  });
  // A case with no history at all cannot be decomposed and must be excluded.
  await makeCase(c, {
    id: 'CASE-NOHIST',
    number: 'CASE-9003',
    raisedAt: '2026-08-21 09:00:00',
    resolvedAt: '2026-08-21 11:00:00',
  });

  const result = await waitingBreakdown(
    asClient(c),
    SEED.admin,
    filter('from=2026-08-21&to=2026-08-21'),
  );
  assert.equal(result.casesMeasured, 1);
  assert.equal(result.casesExcluded, 1, 'the case with no events is excluded, not guessed');
  assert.equal(result.totalCases, 2);
  assert.equal(result.waitingCustomerMinutes, 120);
  assert.equal(result.waitingInternalMinutes, 120);
  assert.equal(result.activeHandlingMinutes, 120);
  assert.equal(
    result.waitingCustomerMinutes + result.waitingInternalMinutes + result.activeHandlingMinutes,
    result.elapsedMinutes,
    'the three bands are the decomposition, so they sum to the elapsed total',
  );
  assert.equal(result.elapsedMinutes, 360);
});

test('internal waiting is not presented as excusable', async () => {
  const c = await db();
  const result = await waitingBreakdown(asClient(c), SEED.admin, filter());
  assert.equal(result.wording, INTERNAL_WAITING_WORDING);
  assert.ok(result.wording.includes('is not excused'));
  assert.ok(result.wording.includes('worth acting on'));
  assert.equal(
    /acceptable|excusable delay|unavoidable/i.test(result.wording.replace('is not excused', '')),
    false,
  );
});

test('a handoff chain is reconstructed in order and labelled without judgement', async () => {
  const c = await db();
  await makeCase(c, { id: 'CASE-HO', number: 'CASE-9004', raisedAt: '2026-08-22 08:00:00' });
  const moves = [
    { at: '2026-08-22 08:10:00', from: null, to: 'TEAM-CS-KE' },
    { at: '2026-08-22 09:30:00', from: 'TEAM-CS-KE', to: 'TEAM-FIN-KE' },
    { at: '2026-08-22 11:45:00', from: 'TEAM-FIN-KE', to: 'TEAM-OPS-KE' },
  ];
  for (const [index, move] of moves.entries()) {
    await c.execute({
      sql: `INSERT INTO case_assignment_history
              (case_assignment_id, case_id, from_team_id, from_user_id, to_team_id, to_user_id,
               assigned_by_user_id, assigned_at, reason)
            VALUES (?, 'CASE-HO', ?, NULL, ?, NULL, 'USR-CATH', ?, 'test')`,
      args: [`CAH-${index}`, move.from, move.to, move.at],
    });
  }

  const result = await handoffs(asClient(c), SEED.admin, filter('from=2026-08-22&to=2026-08-22'));
  const row = result.rows.find((candidate) => candidate.caseId === 'CASE-HO');
  assert.equal(row?.handoffs, 3);
  assert.deepEqual(
    row?.chain.map((step) => step.at),
    ['2026-08-22 08:10:00', '2026-08-22 09:30:00', '2026-08-22 11:45:00'],
    'the chain is in the order it happened',
  );
  assert.equal(row?.chain[1]?.fromTeam, 'Kenya Customer Service');
  assert.equal(row?.highReassignment, true);
  assert.equal(result.wording, HIGH_REASSIGNMENT_WORDING);
  assert.ok(result.wording.includes('not a judgement'));
  assert.equal(/poorly handled|badly|failure/i.test(result.wording), false);
});

test('counting happens on the category, and free text is never a dimension', async () => {
  const c = await db();
  await c.execute(
    `UPDATE service_cases SET root_cause = 'Pump seal failed again' WHERE case_id = 'CASE-001'`,
  );
  const categories = await categoryMix(asClient(c), SEED.admin, filter());
  assert.ok(categories.length > 0);
  for (const row of categories) {
    assert.notEqual(row.caseCategoryId, '');
    assert.notEqual(row.categoryName, '');
  }
  // Nothing in the shape carries a root cause, so nothing can be counted by it.
  assert.equal(Object.keys(categories[0] ?? {}).includes('rootCause'), false);

  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/lib/cms/repos/serviceAnalytics.ts', 'utf8');
  const grouped = source
    .split('\n')
    .filter((line) => line.includes('root_cause') && /GROUP BY|COUNT\(/.test(line));
  assert.equal(grouped.length, 0, 'root_cause never appears in a grouping or a count');
});

test('repeat issues use a configurable window with a stated default', async () => {
  const c = await db();
  await makeCase(c, {
    id: 'CASE-R1',
    number: 'CASE-9005',
    raisedAt: '2026-08-01 08:00:00',
    accountId: 'ACC-001',
    categoryId: 'CC-001',
  });
  await makeCase(c, {
    id: 'CASE-R2',
    number: 'CASE-9006',
    raisedAt: '2026-08-10 08:00:00',
    accountId: 'ACC-001',
    categoryId: 'CC-001',
  });

  const wide = await repeatIssues(asClient(c), SEED.admin, filter('from=2026-08-01&to=2026-08-31'));
  assert.equal(wide.windowDays, 90, 'the default is stated in the result');
  const found = wide.rows.find((row) => row.accountId === 'ACC-001');
  assert.ok((found?.cases ?? 0) >= 2);
  assert.ok(wide.wording.includes('NOT a claim'));
  assert.equal(wide.wording, REPEAT_WORDING);

  // A narrower window is a query parameter, not a constant in the code.
  const narrow = await repeatIssues(
    asClient(c),
    SEED.admin,
    filter('from=2026-08-01&to=2026-08-31&repeatDays=3'),
  );
  assert.equal(narrow.windowDays, 3);
  assert.equal(
    narrow.rows.some((row) => row.accountId === 'ACC-001' && row.caseCategoryId === 'CC-001'),
    false,
    'nine days apart is not a repeat inside a three day window',
  );
});

test('a complaint rate appears only where a denominator exists', async () => {
  const c = await db();
  const rows = await entityView(asClient(c), SEED.admin, filter());
  assert.ok(rows.length > 0);
  for (const row of rows) {
    if (row.ordersInPeriod === null) {
      assert.equal(row.complaintRatePercent, null, 'no denominator, no rate');
      assert.equal(row.rateNote, NO_DENOMINATOR_NOTE);
      assert.ok(row.cases >= 0, 'the count is still shown');
    } else {
      assert.notEqual(row.complaintRatePercent, null);
      assert.ok(row.rateNote.includes('sales orders raised'));
    }
  }

  // A period with no orders at all yields counts and no rates.
  const future = await entityView(asClient(c), SEED.admin, filter('from=2030-01-01&to=2030-01-31'));
  assert.equal(
    future.every((row) => row.complaintRatePercent === null),
    true,
  );
});

test('a breach is attributed from the breach row, not to whoever closed the case', async () => {
  const c = await db();
  await makeCase(c, {
    id: 'CASE-BR',
    number: 'CASE-9007',
    raisedAt: '2026-08-23 08:00:00',
    resolvedAt: '2026-08-23 18:00:00',
    statuses: [
      { at: '2026-08-23 08:00:00', to: 'IN_PROGRESS' },
      { at: '2026-08-23 17:00:00', to: 'RESOLVED' },
    ],
  });
  // Victor held the case while it breached. Catherine rescued and closed it.
  await c.execute(`INSERT INTO sla_instances
      (sla_instance_id, sla_rule_id, entity_type, entity_id, workflow_stage_instance_id,
       accountable_user_id, accountable_team_id, started_at, target_at, warning_at, stopped_at,
       paused_minutes, status, breached_at)
    VALUES ('SLAI-BR','SLAR-001','CASE','CASE-BR',NULL,'USR-VIC','TEAM-CRD-GRP',
            '2026-08-23 08:00:00','2026-08-23 12:00:00','2026-08-23 11:00:00','2026-08-23 18:00:00',
            0,'BREACHED','2026-08-23 12:00:00')`);
  await c.execute(`INSERT INTO sla_breaches
      (sla_breach_id, sla_instance_id, entity_type, entity_id, breached_at, target_at,
       breach_minutes, accountable_user_id, accountable_team_id, workflow_stage_instance_id)
    VALUES ('SLAB-BR','SLAI-BR','CASE','CASE-BR','2026-08-23 12:00:00','2026-08-23 12:00:00',
            360,'USR-VIC','TEAM-CRD-GRP',NULL)`);
  await c.execute(`UPDATE case_status_history SET changed_by_user_id = 'USR-CATH'
    WHERE case_id = 'CASE-BR' AND to_status = 'RESOLVED'`);

  const rows = await breachAttribution(
    asClient(c),
    SEED.admin,
    filter('from=2026-08-23&to=2026-08-23'),
  );
  const row = rows.find((candidate) => candidate.caseId === 'CASE-BR');
  assert.equal(row?.accountableUser, 'Victor Njoroge');
  assert.equal(row?.accountableTeam, 'Group Credit');
  assert.equal(row?.closedByUser, 'Catherine Mwangi');
  assert.notEqual(
    row?.accountableUser,
    row?.closedByUser,
    'the person who closed the case is not the person the breach belongs to',
  );

  const picture = await slaPicture(
    asClient(c),
    SEED.admin,
    filter('from=2026-08-23&to=2026-08-23'),
    NOW,
  );
  assert.equal(picture.attributionNote, BREACH_ATTRIBUTION_NOTE);
  assert.ok(picture.attributionNote.includes('never to whoever closed the case'));
});

test('CSAT, NPS and CES are never averaged together, and NPS is promoters minus detractors', async () => {
  const c = await db();
  await makeCase(c, {
    id: 'CASE-S1',
    number: 'CASE-9008',
    raisedAt: '2026-08-24 08:00:00',
    resolvedAt: '2026-08-24 09:00:00',
  });
  await c.execute(`INSERT INTO customer_surveys (survey_id, survey_name, survey_type, question_text, active)
    VALUES ('SUR-NPS','Relationship NPS','NPS','How likely are you to recommend Hass?',1)`);
  await c.execute(`INSERT INTO customer_surveys (survey_id, survey_name, survey_type, question_text, active)
    VALUES ('SUR-CES','Effort','CES','How easy was it to get this resolved?',1)`);
  // Five NPS answers: three promoters (10, 9, 9), one passive (7), one detractor (3).
  const nps = [10, 9, 9, 7, 3];
  for (const [index, score] of nps.entries()) {
    await c.execute({
      sql: `INSERT INTO survey_responses (survey_response_id, survey_id, case_id, account_id, contact_id, score, comments, responded_at)
            VALUES (?, 'SUR-NPS', 'CASE-S1', 'ACC-001', NULL, ?, NULL, '2026-08-24 10:00:00')`,
      args: [`SRESP-N${index}`, score],
    });
  }
  await c.execute(`INSERT INTO survey_responses (survey_response_id, survey_id, case_id, account_id, contact_id, score, comments, responded_at)
    VALUES ('SRESP-C1','SUR-CES','CASE-S1','ACC-001',NULL,2,NULL,'2026-08-24 10:00:00')`);

  const scores = await surveyScores(
    asClient(c),
    SEED.admin,
    filter('from=2026-08-24&to=2026-08-24'),
  );
  const npsRow = scores.find((row) => row.surveyType === 'NPS');
  const cesRow = scores.find((row) => row.surveyType === 'CES');
  assert.notEqual(npsRow, undefined);
  assert.notEqual(cesRow, undefined);

  // 3 promoters and 1 detractor of 5: (3 - 1) / 5 = 40.
  assert.equal(npsRow?.score, 40);
  assert.deepEqual(npsRow?.nps, { promoters: 3, passives: 1, detractors: 1 });
  assert.ok(npsRow?.scale.includes('-100 to +100'));

  // CES is a mean on its own scale and is a separate row. The figure is
  // checked against the CES responses in this period rather than assumed.
  const cesExpected = await c.execute(`
    SELECT AVG(sr.score) AS mean FROM survey_responses sr
    JOIN customer_surveys cs ON cs.survey_id = sr.survey_id
    JOIN service_cases sc ON sc.case_id = sr.case_id
    WHERE cs.survey_type = 'CES' AND date(sc.raised_at) = '2026-08-24'`);
  assert.equal(cesRow?.score, Math.round(Number(cesExpected.rows[0]?.mean) * 100) / 100);
  assert.equal(cesRow?.nps, null);
  assert.notEqual(npsRow?.score, cesRow?.score, 'the two instruments are never one figure');

  // One row per instrument: nothing merges them.
  const types = scores.map((row) => row.surveyType);
  assert.equal(new Set(types).size, types.length);
});

test('response rate excludes non-responses rather than imputing them', async () => {
  const c = await db();
  await makeCase(c, {
    id: 'CASE-F1',
    number: 'CASE-9009',
    raisedAt: '2026-08-25 08:00:00',
    resolvedAt: '2026-08-25 09:00:00',
  });
  await makeCase(c, {
    id: 'CASE-F2',
    number: 'CASE-9010',
    raisedAt: '2026-08-25 08:00:00',
    resolvedAt: '2026-08-25 09:00:00',
  });
  await c.execute(`INSERT INTO survey_responses (survey_response_id, survey_id, case_id, account_id, contact_id, score, comments, responded_at)
    VALUES ('SRESP-F1','SUR-001','CASE-F1','ACC-001',NULL,8,NULL,'2026-08-25 10:00:00')`);

  const period = filter('from=2026-08-25&to=2026-08-25');
  const coverage = await feedbackCoverage(asClient(c), SEED.admin, period);
  assert.equal(coverage.closedCases, 2);
  assert.equal(coverage.responses, 1);
  assert.equal(coverage.responseRatePercent, 50);
  assert.equal(coverage.note, FEEDBACK_COVERAGE_NOTE);
  assert.ok(coverage.note.includes('never counted as neutral'));

  const scores = await surveyScores(asClient(c), SEED.admin, period);
  const csat = scores.find((row) => row.surveyType === 'CSAT');
  assert.equal(csat?.responses, 1, 'one answer, one response');
  assert.equal(csat?.score, 8, 'the silent case did not drag the score toward a middle value');
});

test('team and customer aggregates respect scope and match the detail lists', async () => {
  const c = await db();
  const population = await casePopulation(asClient(c), SEED.admin, filter());
  const total = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  const teams = await teamView(asClient(c), SEED.admin, filter());
  const teamTotal = teams.reduce((sum, row) => sum + row.casesHandled, 0);
  assert.equal(teamTotal, Number(total.rows[0]?.n), 'every case is in exactly one team row');

  const customers = await customerView(asClient(c), SEED.admin, filter());
  const customerTotal = customers.reduce((sum, row) => sum + row.cases, 0);
  assert.equal(customerTotal, Number(total.rows[0]?.n));

  // A user with no case permission sees nothing.
  const nobody = await casePopulation(asClient(c), 'USR-FMUG', filter());
  const nobodyCount = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${nobody.source} WHERE ${nobody.where}`,
    args: nobody.args as never[],
  });
  const nobodySummary = await summary(asClient(c), 'USR-FMUG', filter());
  assert.equal(nobodySummary.casesOpened, Number(nobodyCount.rows[0]?.n));
});

test('an insight card is reproducible arithmetic and claims no cause', async () => {
  const c = await db();
  await makeCase(c, {
    id: 'CASE-I1',
    number: 'CASE-9011',
    raisedAt: '2026-08-26 08:00:00',
    resolvedAt: '2026-08-26 14:00:00',
    statuses: [
      { at: '2026-08-26 08:00:00', to: 'IN_PROGRESS' },
      { at: '2026-08-26 10:00:00', to: 'WAITING_INTERNAL' },
    ],
  });
  for (const index of [2, 3, 4, 5, 6]) {
    await makeCase(c, {
      id: `CASE-I${index}`,
      number: `CASE-90${index}0`,
      raisedAt: '2026-08-26 09:00:00',
      resolvedAt: '2026-08-26 10:00:00',
      statuses: [{ at: '2026-08-26 09:00:00', to: 'IN_PROGRESS' }],
    });
  }

  const cards = await insights(asClient(c), SEED.admin, filter('from=2026-08-26&to=2026-08-26'));
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.ok(card.working.length > 20, 'the working is stated, not implied');
    assert.ok(card.sampleSize > 0);
    assert.equal(
      /caused|because of|led to|resulted in/i.test(card.headline),
      false,
      `a card headline must not claim a cause: ${card.headline}`,
    );
  }

  // The category card is reproducible: recompute it from the same records.
  const categoryCard = cards.find((card) => card.headline.includes('% of cases'));
  if (categoryCard !== undefined) {
    const categories = await categoryMix(
      asClient(c),
      SEED.admin,
      filter('from=2026-08-26&to=2026-08-26'),
    );
    const totalCases = categories.reduce((sum, row) => sum + row.cases, 0);
    const share = Math.round(((categories[0]?.cases ?? 0) / totalCases) * 1000) / 10;
    assert.ok(
      categoryCard.headline.includes(`${share}%`),
      'the headline figure recomputes exactly',
    );
    assert.equal(categoryCard.sampleSize, totalCases);
  }
});

test('the trend and the empty case behave', async () => {
  const c = await db();
  const buckets = await trend(asClient(c), SEED.admin, filter());
  assert.ok(buckets.length > 0);
  for (const bucket of buckets) {
    assert.ok(bucket.cases > 0);
    assert.ok(bucket.csatResponses >= 0);
  }
  const empty = await trend(asClient(c), SEED.admin, filter('from=2030-01-01&to=2030-01-31'));
  assert.equal(empty.length, 0);

  const emptySummary = await summary(
    asClient(c),
    SEED.admin,
    filter('from=2030-01-01&to=2030-01-31'),
  );
  assert.equal(emptySummary.casesOpened, 0);
  assert.equal(emptySummary.externalSlaCompliancePercent, null);
  assert.equal(formatRate(emptySummary.externalSlaCompliancePercent), 'Not available');
  assert.equal(formatDuration(emptySummary.medianResolutionElapsedMinutes), 'Not available');
});
