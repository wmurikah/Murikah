/**
 * Phase 22: CRM analytics.
 *
 * The failures this phase exists to prevent are all arithmetic that looks
 * right: a win rate that drifts with pipeline size, a weighted pipeline
 * inflated a hundredfold, two currencies added together, a velocity figure
 * computed only from the deals that are stuck, and a team's history rewritten
 * every time somebody changes desk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { formatDuration, formatRate } from '../../src/lib/cms/analytics/stats.ts';
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
  trend,
  leadPopulation,
  opportunityPopulation,
  WIN_RATE_DEFINITION,
  BANT_WORDING,
  PIPELINE_ESTIMATE_NOTE,
  CUSTOMER_SERVICE_LEAD_SOURCES,
} from '../../src/lib/cms/repos/crmAnalytics.ts';
import { funnelChart } from '../../src/lib/cms/charts/svg.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const NOW = '2026-08-27 10:00:00';

/**
 * The permissions the phase 12 data script adds, mirrored here.
 *
 * `docs/cms/crm/04_add_opportunity_permissions.sql` is run by the operator,
 * so the seeded catalogue does not carry PERM-036 to PERM-038 and every
 * opportunity query would otherwise be refused for everybody, which is the
 * correct direction to fail but makes for a test that proves nothing.
 */
async function grantCrmPermissions(c: TestClient): Promise<void> {
  await c.execute(`INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
    ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline'),
    ('PERM-037','CRM','PIPELINES','MANAGE','Configure pipelines and stages'),
    ('PERM-038','CRM','LOST_REASONS','MANAGE','Configure lost reasons')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
    FROM permissions WHERE permission_id IN ('PERM-031','PERM-036','PERM-037','PERM-038')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    VALUES ('RP-SAL-009','ROLE-SALES','PERM-036',1,CURRENT_TIMESTAMP)`);
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
const asClient = (c: TestClient) => c as unknown as Parameters<typeof funnel>[0];
const filter = (query = '') => parseFilter(new URLSearchParams(query));

test('the funnel reconciles with the lead list under the same filter', async () => {
  const c = await db();
  const result = await funnel(asClient(c), SEED.admin, filter());
  const population = await leadPopulation(asClient(c), SEED.admin, filter());
  const listed = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  assert.equal(
    result.steps[0]?.leads,
    Number(listed.rows[0]?.n),
    'the funnel top is the lead list',
  );

  // Every step carries its own denominator, named.
  for (const step of result.steps.slice(1)) {
    assert.notEqual(step.denominator, '');
    assert.ok(step.denominator.includes('leads'));
  }
  const contacted = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${population.source}
          WHERE ${population.where} AND l.first_contact_at IS NOT NULL`,
    args: population.args as never[],
  });
  assert.equal(result.steps[1]?.leads, Number(contacted.rows[0]?.n));
});

test('the funnel is stepped bars and never a tapering shape', () => {
  const chart = funnelChart([
    { label: 'Captured', value: 100 },
    { label: 'Contacted', value: 70 },
    { label: 'Qualified', value: 35 },
  ]);
  assert.equal(chart.svg.includes('polygon'), false);
  assert.equal(chart.svg.includes('path'), false, 'no tapering outline is drawn');
  assert.equal(chart.table.rows[1]?.[2], '70%');
  assert.equal(chart.table.rows[2]?.[2], '50%');
});

test('win rate excludes open opportunities from its denominator', async () => {
  const c = await db();
  const before = await winRate(asClient(c), SEED.admin, filter());
  assert.equal(before.denominator, before.won + before.lost);
  assert.ok(before.open > 0, 'the seed has open opportunities');
  assert.equal(
    before.denominator < before.won + before.lost + before.open,
    true,
    'the open ones are counted and reported, and are not in the denominator',
  );
  assert.ok(before.definition.includes('NOT in the denominator'));
  assert.equal(before.definition, WIN_RATE_DEFINITION);

  // Adding an open opportunity must not move the win rate. This is the whole
  // point of the exclusion.
  await c.execute(`INSERT INTO opportunities
      (opportunity_id, opportunity_number, account_id, pipeline_id, current_stage_id,
       owner_user_id, title, estimated_value, currency_code, probability, status, created_at, updated_at)
    VALUES ('OPP-NEW','OPP-9001','ACC-001','PIPE-001','PST-KE-01','USR-JAM','New deal',
            1000000,'KES',0.3,'OPEN',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  const after = await winRate(asClient(c), SEED.admin, filter());
  assert.equal(after.open, before.open + 1);
  assert.equal(
    after.winRatePercent,
    before.winRatePercent,
    'a new open deal changes pipeline size, not anybody performance',
  );
});

test('weighted pipeline multiplies by the stored fraction and shows a percentage', async () => {
  const c = await db();
  const rows = await pipelineValue(asClient(c), SEED.admin, filter());
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(
      row.weightedValue <= row.openValue + 0.001,
      'weighted can never exceed unweighted: the multiplier is a fraction, not a percentage',
    );
    assert.ok((row.averageProbabilityPercent ?? 0) <= 100);
    assert.ok((row.averageProbabilityPercent ?? 0) >= 0);
  }

  // The arithmetic, checked directly against the stored fractions.
  const expected = await c.execute(
    `SELECT currency_code, SUM(estimated_value * probability) AS w
     FROM opportunities WHERE status = 'OPEN' GROUP BY currency_code`,
  );
  for (const raw of expected.rows) {
    const row = rows.find((candidate) => candidate.currencyCode === String(raw.currency_code));
    assert.ok(Math.abs((row?.weightedValue ?? 0) - Number(raw.w)) < 0.01);
  }
});

test('two currencies are never summed, and no total row adds them', async () => {
  const c = await db();
  await c.execute(`INSERT INTO opportunities
      (opportunity_id, opportunity_number, account_id, pipeline_id, current_stage_id,
       owner_user_id, title, estimated_value, currency_code, probability, status, created_at, updated_at)
    VALUES ('OPP-USD','OPP-9002','ACC-001','PIPE-001','PST-KE-01','USR-JAM','Dollar deal',
            50000,'USD',0.5,'OPEN',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  const rows = await pipelineValue(asClient(c), SEED.admin, filter());
  const currencies = rows.map((row) => row.currencyCode);
  assert.ok(currencies.includes('USD'));
  assert.ok(currencies.includes('KES'));
  assert.equal(new Set(currencies).size, currencies.length, 'one row per currency');
  // The shape offers no cross-currency total, because there is no rate.
  assert.equal(Object.keys(rows[0] ?? {}).includes('totalValue'), false);
  assert.equal(Object.keys(rows[0] ?? {}).includes('grandTotal'), false);
});

test('stage velocity comes from the history and includes deals that moved on', async () => {
  const c = await db();
  const velocity = await stageVelocity(asClient(c), SEED.admin, filter());
  const withMoves = velocity.filter((row) => row.transitions > 0);
  assert.ok(withMoves.length > 0, 'the seed records stage transitions');

  // An opportunity that has already moved on contributes to the stage it
  // left. A current-stage-age reading would miss it entirely.
  const movedOn = await c.execute(`
    SELECT h.from_stage_id AS stage_id, COUNT(*) AS n
    FROM opportunity_stage_history h
    JOIN opportunities o ON o.opportunity_id = h.opportunity_id
    WHERE h.from_stage_id IS NOT NULL AND o.current_stage_id <> h.from_stage_id
    GROUP BY h.from_stage_id`);
  assert.ok(movedOn.rows.length > 0);
  for (const raw of movedOn.rows) {
    const row = velocity.find((candidate) => candidate.pipelineStageId === String(raw.stage_id));
    assert.ok(
      (row?.transitions ?? 0) >= Number(raw.n),
      'every recorded departure from a stage is in that stage velocity',
    );
  }
});

test('a stage with a target flags risk; a stage without one shows age and no judgement', async () => {
  const c = await db();
  const stages = await stageOccupancy(asClient(c), SEED.admin, filter(), NOW);
  assert.ok(stages.length > 0);

  const withTarget = stages.filter((stage) => stage.targetDays !== null);
  const withoutTarget = stages.filter((stage) => stage.targetDays === null);
  assert.ok(withTarget.length > 0, 'the seeded pipeline configures some targets');
  assert.equal(
    withTarget.every((stage) => stage.atRisk !== null),
    true,
    'a configured target produces a risk count',
  );
  assert.equal(
    withoutTarget.every((stage) => stage.atRisk === null),
    true,
    'no configured target, no invented threshold and no judgement',
  );
  assert.equal(
    stages.every(
      (stage) => stage.medianStageAgeMinutes === null || stage.medianStageAgeMinutes >= 0,
    ),
    true,
    'the age is still reported either way',
  );
});

test('first contact agrees with the SLA engine where a rule exists', async () => {
  const c = await db();
  const contact = await firstContact(asClient(c), SEED.admin, filter());
  const engine = await c.execute(`
    SELECT SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met,
           SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
    FROM sla_instances si WHERE si.entity_type = 'LEAD'`);
  const met = Number(engine.rows[0]?.met ?? 0);
  const breached = Number(engine.rows[0]?.breached ?? 0);
  assert.equal(
    contact.slaMeasured,
    met + breached,
    'the compliance figure is the engine own timers',
  );
  assert.ok(contact.leads > 0);
  assert.equal(contact.contacted + contact.uncontacted, contact.leads);
  if (contact.uncontacted > 0) assert.notEqual(contact.oldestUncontactedAt, null);
});

test('BANT reports four dimensions and never one score, and claims no cause', async () => {
  const c = await db();
  const result = await bant(asClient(c), SEED.admin, filter());
  assert.equal(result.rows.length, 4);
  assert.deepEqual(
    result.rows.map((row) => row.dimension),
    ['Budget', 'Authority', 'Need', 'Timeline'],
  );
  // No combined figure exists anywhere in the shape.
  assert.equal(Object.keys(result).includes('score'), false);
  assert.equal(Object.keys(result.rows[0] ?? {}).includes('total'), false);
  assert.equal(result.wording, BANT_WORDING);
  assert.ok(result.wording.includes('no combined lead score'));
  assert.ok(result.wording.includes('is not a cause'));
  assert.equal(/causes|because|drives/i.test(result.wording.replace('is not a cause', '')), false);
});

test('customer service sourced leads are reported separately', async () => {
  const c = await db();
  const sources = await leadSourcePerformance(asClient(c), SEED.admin, filter());
  const service = sources.filter((row) => row.isCustomerService);
  assert.equal(service.length, 1, 'the configured service source is identifiable on its own');
  assert.equal(service[0]?.leadSourceId, CUSTOMER_SERVICE_LEAD_SOURCES[0]);
  assert.equal(service[0]?.sourceName, 'Customer Service Referral');
  assert.ok(service[0]?.leads !== undefined);
  // The flag is a configured id list, not a match on the words in the name.
  await c.execute(
    `UPDATE lead_sources SET source_name = 'Renamed entirely' WHERE lead_source_id = 'LS-001'`,
  );
  const renamed = await leadSourcePerformance(asClient(c), SEED.admin, filter());
  assert.equal(
    renamed.find((row) => row.leadSourceId === 'LS-001')?.isCustomerService,
    true,
    'renaming a source does not silently reclassify it',
  );
});

test('quantities in different units are not summed', async () => {
  const c = await db();
  const rows = await productPipeline(asClient(c), SEED.admin, filter());
  assert.ok(rows.length > 0);
  const units = new Set(rows.map((row) => row.unitOfMeasure));
  assert.ok(units.size > 1, 'the seeded catalogue mixes litres and units');
  // Each row is one product and therefore one unit, and the shape has no
  // total across rows.
  for (const row of rows) {
    assert.notEqual(row.unitOfMeasure, '');
    assert.equal(row.pipelineByCurrency.length >= 1, true);
  }
  assert.equal(
    rows.some((row) => Object.keys(row).includes('totalQuantity')),
    false,
    'there is no quantity total across incompatible units',
  );
});

test('team attribution uses the membership that was in force at the time', async () => {
  const c = await db();
  // Somebody moved teams in July. A lead they captured in March belongs to
  // the team they were in during March.
  await c.execute(`INSERT INTO teams (team_id, team_name, team_type, business_unit_id, affiliate_id, manager_user_id, active, created_at)
    VALUES ('TEAM-OLD','Historic Sales Team','SALES','BU-CI','AFF-KE','USR-AMN',1,CURRENT_TIMESTAMP)`);
  await c.execute(
    `UPDATE team_members SET effective_from = '2026-07-01' WHERE user_id = 'USR-JAM'`,
  );
  await c.execute(`INSERT INTO team_members (team_member_id, team_id, user_id, member_role, effective_from, effective_to, active)
    VALUES ('TM-OLD','TEAM-OLD','USR-JAM','MEMBER','2026-01-01','2026-06-30',0)`);
  await c.execute(`INSERT INTO leads
      (lead_id, lead_number, lead_source_id, owner_user_id, title, captured_at, status, created_by_user_id, created_at)
    VALUES ('LEAD-MAR','LEAD-9001','LS-002','USR-JAM','March enquiry','2026-03-15 09:00:00','NEW','USR-CATH',CURRENT_TIMESTAMP)`);

  const teams = await teamPerformance(
    asClient(c),
    SEED.admin,
    filter('from=2026-03-01&to=2026-03-31'),
  );
  const historic = teams.find((team) => team.teamId === 'TEAM-OLD');
  const current = teams.find((team) => team.teamId === 'TEAM-SALES-KE');
  assert.equal(historic?.leadsOwned, 1, 'the March lead belongs to the March team');
  assert.equal(
    current?.leadsOwned,
    0,
    "and not to the team the owner joined in July: history is not rewritten by today's structure",
  );
});

test('losses come from the configured reasons, not from free text', async () => {
  const c = await db();
  const losses = await lossAnalysis(asClient(c), SEED.admin, filter());
  for (const row of losses) {
    assert.notEqual(row.reasonName, '');
    // Every row is either a configured reason or the explicit "Not recorded".
    if (row.lostReasonId !== null) {
      const configured = await c.execute({
        sql: `SELECT COUNT(*) AS n FROM lost_reasons WHERE lost_reason_id = ?`,
        args: [row.lostReasonId],
      });
      assert.equal(Number(configured.rows[0]?.n), 1);
    } else {
      assert.equal(row.reasonName, 'Not recorded');
    }
    assert.ok(row.lostValueByCurrency.length >= 1, 'lost value carries its currency');
  }
});

test('the forecast view is labelled an estimate and builds no model', async () => {
  const c = await db();
  const estimate = await pipelineEstimate(asClient(c), SEED.admin, filter());
  assert.ok(estimate.label.includes('estimate'));
  assert.equal(estimate.label.toLowerCase().includes('forecast'), false);
  assert.equal(estimate.note, PIPELINE_ESTIMATE_NOTE);
  assert.ok(estimate.note.includes('not a revenue forecast'));
  assert.ok(estimate.note.includes('No model'));
  for (const row of estimate.rows) {
    assert.ok(row.weightedValue <= row.unweightedValue + 0.001);
    assert.notEqual(row.currencyCode, '');
  }
});

test('an own-scope user total excludes everything outside their scope', async () => {
  const c = await db();
  const groupFunnel = await funnel(asClient(c), SEED.admin, filter());
  const jamesFunnel = await funnel(asClient(c), 'USR-JAM', filter());
  assert.ok(jamesFunnel.steps[0]!.leads <= groupFunnel.steps[0]!.leads);

  const population = await leadPopulation(asClient(c), 'USR-JAM', filter());
  const listed = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  assert.equal(
    jamesFunnel.steps[0]?.leads,
    Number(listed.rows[0]?.n),
    'the aggregate matches his own detail list exactly',
  );

  // And the pipeline value he sees never includes a Group figure.
  const jamesPipeline = await pipelineValue(asClient(c), 'USR-JAM', filter());
  const groupPipeline = await pipelineValue(asClient(c), SEED.admin, filter());
  const jamesTotal = jamesPipeline.reduce((sum, row) => sum + row.openValue, 0);
  const groupTotal = groupPipeline.reduce((sum, row) => sum + row.openValue, 0);
  assert.ok(jamesTotal <= groupTotal);

  const oppPopulation = await opportunityPopulation(asClient(c), 'USR-JAM', filter());
  const oppListed = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${oppPopulation.source} WHERE ${oppPopulation.where} AND o.status = 'OPEN'`,
    args: oppPopulation.args as never[],
  });
  assert.equal(
    jamesPipeline.reduce((sum, row) => sum + row.openOpportunities, 0),
    Number(oppListed.rows[0]?.n),
  );
});

test('the empty case renders with no division by zero and no NaN', async () => {
  const c = await db();
  const empty = filter('from=2030-01-01&to=2030-01-31');
  const [f, w, p, s, v, contact, b, owners, health, buckets] = await Promise.all([
    funnel(asClient(c), SEED.admin, empty),
    winRate(asClient(c), SEED.admin, empty),
    pipelineValue(asClient(c), SEED.admin, empty),
    stageOccupancy(asClient(c), SEED.admin, empty, NOW),
    stageVelocity(asClient(c), SEED.admin, empty),
    firstContact(asClient(c), SEED.admin, empty),
    bant(asClient(c), SEED.admin, empty),
    ownerPerformance(asClient(c), SEED.admin, empty, NOW),
    followUpHealth(asClient(c), SEED.admin, empty, NOW),
    trend(asClient(c), SEED.admin, empty),
  ]);
  assert.equal(f.steps[0]?.leads, 0);
  assert.equal(f.qualificationRatePercent, null, 'no leads, no rate, and no NaN');
  assert.equal(w.winRatePercent, null);
  assert.equal(p.length, 0);
  assert.equal(
    v.every((row) => row.medianMinutes === null || Number.isFinite(row.medianMinutes)),
    true,
  );
  assert.equal(contact.medianMinutes, null);
  assert.equal(
    b.rows.every((row) => row.averageWhenConverted === null),
    true,
  );
  assert.equal(owners.rows.length, 0);
  assert.equal(health.leadsWithNoFirstContact, 0);
  assert.equal(buckets.length, 0);
  assert.equal(formatRate(null), 'Not available');
  assert.equal(formatDuration(null), 'Not available');
  assert.equal(
    s.every((stage) => stage.openOpportunities === 0),
    true,
  );
});
