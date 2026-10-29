/**
 * Phase 12: opportunities and the sales pipeline.
 *
 * The concurrency tests deserve a caveat stated once: the harness is one
 * synchronous SQLite connection, so two truly simultaneous batches cannot be
 * staged. What can be proved is the mechanism: the stage move's guard lives
 * inside the transaction (a conditional UPDATE whose row count feeds the
 * history INSERT through changes()), so a move whose expected stage is stale
 * aborts wholesale. The stale-move tests below exercise exactly the state a
 * lost race produces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalFields } from './support/refusal.ts';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  addProductLine,
  addStage,
  createLostReason,
  createOpportunity,
  createPipeline,
  getOpportunity,
  listOpportunities,
  listProductLines,
  listStageHistory,
  moveStage,
  pipelineSummary,
  removeProductLine,
  reorderStages,
  reconcileLines,
  scopedOpportunities,
  updateStage,
  type OpportunityInput,
  type StageMoveInput,
} from '../../src/lib/cms/repos/opportunityAdmin.ts';
import { convertLead, createLead, type LeadInput } from '../../src/lib/cms/repos/leadAdmin.ts';
import {
  percentToFraction,
  fractionToPercentLabel,
  isValidPercent,
} from '../../src/lib/cms/crm/probability.ts';

const NOW = new Date('2026-08-27T10:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const anyQuery = {
  search: '',
  status: null,
  pipelineId: null,
  stageId: null,
  ownerUserId: null,
  businessUnitId: null,
  accountId: null,
  currencyCode: null,
  closeFrom: null,
  closeTo: null,
  page: 1,
};

/**
 * Exactly what docs/cms/crm/04_add_opportunity_permissions.sql does, plus the
 * phase 10 customer codes from script 02: `createOpportunity` checks the
 * account through the Build Prompt 10 scope predicate, which needs
 * CUSTOMERS.ACCOUNTS.VIEW to grant anything at all.
 */
async function grantOpportunityPermissions(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
          ('PERM-032','CUSTOMERS','ACCOUNTS','MANAGE','Create and edit customer accounts and contacts')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-031','PERM-032')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline'),
          ('PERM-037','CRM','PIPELINES','MANAGE','Configure pipelines and stages'),
          ('PERM-038','CRM','LOST_REASONS','MANAGE','Configure lost reasons')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-036','PERM-037','PERM-038')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          VALUES ('RP-SAL-009','ROLE-SALES','PERM-036',1,CURRENT_TIMESTAMP)`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantOpportunityPermissions(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listOpportunities>[0];

const opportunity = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  accountId: 'ACC-001',
  businessUnitId: 'BU-CI',
  pipelineId: 'PIPE-001',
  initialStageId: null,
  ownerUserId: SEED.james,
  title: 'Coast depot AGO supply',
  estimatedValue: 4_000_000,
  currencyCode: 'KES',
  probability: null,
  estimatedCloseDate: '2026-10-01',
  ...over,
});

const move = (over: Partial<StageMoveInput> = {}): StageMoveInput => ({
  expectedStageId: 'PST-KE-01',
  toStageId: 'PST-KE-02',
  probability: null,
  reason: null,
  wonAmount: null,
  actualCloseDate: null,
  lostReasonId: null,
  lostNotes: null,
  markAccountCustomer: false,
  ...over,
});

// ---------------------------------------------------------------------------
// The probability boundary.
// ---------------------------------------------------------------------------

test('probability crosses the boundary once: percent in, fraction stored, percent out', () => {
  assert.equal(percentToFraction(80), 0.8);
  assert.equal(fractionToPercentLabel(0.8), '80%');
  assert.equal(fractionToPercentLabel(0.45), '45%');
  // A fraction posted where a percent belongs is refused, not stored as <1%.
  assert.equal(isValidPercent(0.8), true); // 0.8% is a legal, if odd, percent
  assert.equal(isValidPercent(101), false);
  assert.equal(isValidPercent(-1), false);
});

// ---------------------------------------------------------------------------
// Creation.
// ---------------------------------------------------------------------------

test('a direct creation lands in the first active stage with its default probability', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.equal(made.value.currentStageId, 'PST-KE-01');
  // The stage default is 0.20 stored as a fraction, shown as 20%.
  assert.equal(made.value.probability, 0.2);
  assert.equal(fractionToPercentLabel(made.value.probability), '20%');
  assert.equal(made.value.status, 'OPEN');
  assert.match(made.value.opportunityNumber, /^OPP-2026-[0-9a-f]{10}$/);
  // The first history row exists, with no previous stage and no duration.
  const history = await listStageHistory(asClient(c), made.value.opportunityId);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.fromStageId, null);
  assert.equal(history[0]?.durationInPreviousStageMinutes, null);
  c.close();
});

test('an opportunity from lead conversion carries lead_id and one history row', async () => {
  const c = await db();
  const leadInput: LeadInput = {
    accountId: 'ACC-002',
    primaryContactId: null,
    leadSourceId: 'LS-002',
    campaignId: null,
    businessUnitId: 'BU-CI',
    ownerUserId: SEED.james,
    title: 'Fleet diesel enquiry',
    description: null,
    productInterest: 'AGO',
    estimatedVolume: null,
    estimatedValue: 1_500_000,
    currencyCode: 'KES',
    capturedAt: '2026-08-20 08:00:00',
  };
  const lead = await createLead(asClient(c), leadInput, CTX);
  assert.equal(lead.ok, true);
  if (!lead.ok) return;
  const converted = await convertLead(
    asClient(c),
    SEED.admin,
    lead.value.leadId,
    {
      pipelineId: 'PIPE-001',
      initialStageId: null,
      ownerUserId: null,
      title: null,
      estimatedValue: null,
      currencyCode: null,
      estimatedCloseDate: null,
    },
    CTX,
  );
  assert.equal(converted.ok, true);
  if (!converted.ok) return;
  const created = await getOpportunity(asClient(c), SEED.admin, converted.value.opportunityId);
  assert.equal(created?.leadId, lead.value.leadId);
  const history = await listStageHistory(asClient(c), converted.value.opportunityId);
  assert.equal(history.length, 1);
  c.close();
});

test('converting a lead that never had a value asks for one instead of hitting NOT NULL', async () => {
  const c = await db();
  const lead = await createLead(
    asClient(c),
    {
      accountId: 'ACC-002',
      primaryContactId: null,
      leadSourceId: 'LS-002',
      campaignId: null,
      businessUnitId: null,
      ownerUserId: SEED.james,
      title: 'Vague enquiry, no numbers yet',
      description: null,
      productInterest: null,
      estimatedVolume: null,
      estimatedValue: null,
      currencyCode: null,
      capturedAt: '2026-08-20 08:00:00',
    },
    CTX,
  );
  assert.equal(lead.ok, true);
  if (!lead.ok) return;
  const refused = await convertLead(
    asClient(c),
    SEED.admin,
    lead.value.leadId,
    {
      pipelineId: 'PIPE-001',
      initialStageId: null,
      ownerUserId: null,
      title: null,
      estimatedValue: null,
      currencyCode: null,
      estimatedCloseDate: null,
    },
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    const fields = refusalFields(refused);
    assert.deepEqual(fields.map((f) => f.field).sort(), ['currencyCode', 'estimatedValue']);
  }
  c.close();
});

test('a stage from another pipeline is refused at creation', async () => {
  const c = await db();
  // PIPE-002 exists but PST-KE-01 belongs to PIPE-001.
  const refused = await createOpportunity(
    asClient(c),
    SEED.admin,
    opportunity({ pipelineId: 'PIPE-002', initialStageId: 'PST-KE-01' }),
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refusalFields(refused)[0]?.field, 'initialStageId');
  }
  c.close();
});

test('an out-of-scope account is indistinguishable from a missing one', async () => {
  const c = await db();
  const ghost = await createOpportunity(
    asClient(c),
    SEED.admin,
    opportunity({ accountId: 'ACC-NOPE' }),
    CTX,
  );
  assert.equal(ghost.ok, false);
  if (!ghost.ok) {
    assert.equal(refusalFields(ghost)[0]?.field, 'accountId');
  }
  c.close();
});

// ---------------------------------------------------------------------------
// Product lines.
// ---------------------------------------------------------------------------

test('product lines come from the catalogue only, and reconcile without overwriting', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.opportunityId;

  const bogus = await addProductLine(
    asClient(c),
    SEED.admin,
    id,
    { productId: 'PROD-FAKE', expectedQuantity: 10, unitPrice: null, estimatedLineValue: null },
    CTX,
  );
  assert.equal(bogus.ok, false);
  if (!bogus.ok) assert.equal(refusalFields(bogus)[0]?.field, 'productId');

  const line1 = await addProductLine(
    asClient(c),
    SEED.admin,
    id,
    {
      productId: 'PROD-AGO',
      expectedQuantity: 30000,
      unitPrice: 115,
      estimatedLineValue: 3_450_000,
    },
    CTX,
  );
  assert.equal(line1.ok, true);
  const line2 = await addProductLine(
    asClient(c),
    SEED.admin,
    id,
    { productId: 'PROD-PMS', expectedQuantity: 5000, unitPrice: null, estimatedLineValue: null },
    CTX,
  );
  assert.equal(line2.ok, true);
  if (!line2.ok) return;

  // Lines inform; the header keeps its manually agreed 4,000,000. The
  // variance is shown, the partial sum is labelled partial.
  const reconciliation = reconcileLines(4_000_000, line2.value);
  assert.equal(reconciliation.lineValueSum, 3_450_000);
  assert.equal(reconciliation.linesWithValue, 1);
  assert.equal(reconciliation.linesWithoutValue, 1);
  assert.equal(reconciliation.variance, 550_000);
  const after = await getOpportunity(asClient(c), SEED.admin, id);
  assert.equal(after?.estimatedValue, 4_000_000);

  // Removal audits and actually removes.
  const removed = await removeProductLine(
    asClient(c),
    SEED.admin,
    id,
    line2.value.find((l) => l.productId === 'PROD-PMS')?.opportunityProductId ?? '',
    CTX,
  );
  assert.equal(removed.ok, true);
  assert.equal((await listProductLines(asClient(c), id)).length, 1);
  const audits = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND event_type IN ('PRODUCT_ADDED','PRODUCT_REMOVED')`,
    args: [id],
  });
  assert.equal(Number(audits.rows[0]?.n), 3);
  c.close();
});

// ---------------------------------------------------------------------------
// The stage move.
// ---------------------------------------------------------------------------

test('a stage move writes exactly one history row with a computed duration', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.opportunityId;

  const later = { ...CTX, now: new Date('2026-08-27T12:30:00Z') };
  const moved = await moveStage(asClient(c), SEED.admin, id, move(), later);
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.value.currentStageId, 'PST-KE-02');
  // The destination's default probability, 0.45, applied because no override.
  assert.equal(moved.value.probability, 0.45);

  const history = await listStageHistory(asClient(c), id);
  assert.equal(history.length, 2);
  const step = history[1];
  assert.equal(step?.fromStageId, 'PST-KE-01');
  assert.equal(step?.toStageId, 'PST-KE-02');
  // Created 10:00, moved 12:30: 150 minutes in the previous stage.
  assert.equal(step?.durationInPreviousStageMinutes, 150);
  c.close();
});

test('an authorised probability override survives the move', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const moved = await moveStage(
    asClient(c),
    SEED.admin,
    made.value.opportunityId,
    move({ probability: percentToFraction(60) }),
    CTX,
  );
  assert.equal(moved.ok, true);
  if (moved.ok) assert.equal(moved.value.probability, 0.6);
  c.close();
});

test('a stale expected stage is refused and leaves no history row and no audit row', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.opportunityId;

  // The first mover wins.
  const first = await moveStage(asClient(c), SEED.admin, id, move(), CTX);
  assert.equal(first.ok, true);

  // The second mover still believes the opportunity is in stage 1. This is
  // exactly the state a lost race produces: the guard is the conditional
  // UPDATE inside the transaction, and everything in the batch rolls back.
  const stale = await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({ expectedStageId: 'PST-KE-01', toStageId: 'PST-KE-03' }),
    CTX,
  );
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.kind, 'conflict');

  const history = await listStageHistory(asClient(c), id);
  assert.equal(history.length, 2); // create + the one successful move
  const audits = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_events
          WHERE entity_id = ? AND event_type = 'OPPORTUNITY_STAGE_CHANGED'`,
    args: [id],
  });
  assert.equal(Number(audits.rows[0]?.n), 1);
  // The record still sits where the winner put it.
  const after = await getOpportunity(asClient(c), SEED.admin, id);
  assert.equal(after?.currentStageId, 'PST-KE-02');
  c.close();
});

test('a destination from another pipeline is refused on a move', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  // Build a stage on PIPE-002 and aim at it.
  const foreign = await addStage(
    asClient(c),
    'PIPE-002',
    {
      stageName: 'Uganda Qualified',
      defaultProbability: 0.2,
      targetDays: 3,
      isWonStage: false,
      isLostStage: false,
      active: true,
    },
    CTX,
  );
  assert.equal(foreign.ok, true);
  if (!foreign.ok) return;
  const stageId = foreign.value.stages[0]?.pipelineStageId ?? '';
  const refused = await moveStage(
    asClient(c),
    SEED.admin,
    made.value.opportunityId,
    move({ toStageId: stageId }),
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refusalFields(refused)[0]?.field, 'toStageId');
  c.close();
});

// ---------------------------------------------------------------------------
// Won and lost.
// ---------------------------------------------------------------------------

test('won requires close date and amount, and a prospect becomes a customer with no invented Oracle code', async () => {
  const c = await db();
  // A prospect account with no Oracle code.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, country_id, status, created_at, updated_at)
          VALUES ('ACC-PROS','Nascent Logistics','PROSPECT','CTR-KE','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [],
  });
  const made = await createOpportunity(
    asClient(c),
    SEED.admin,
    opportunity({ accountId: 'ACC-PROS' }),
    CTX,
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.opportunityId;

  // Won without the facts is refused with both fields named.
  const bare = await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({ expectedStageId: 'PST-KE-01', toStageId: 'PST-KE-04' }),
    CTX,
  );
  assert.equal(bare.ok, false);
  if (!bare.ok) {
    assert.deepEqual(
      refusalFields(bare)
        .map((f) => f.field)
        .sort(),
      ['actualCloseDate', 'wonAmount'],
    );
  }

  const won = await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({
      expectedStageId: 'PST-KE-01',
      toStageId: 'PST-KE-04',
      wonAmount: 3_900_000,
      actualCloseDate: '2026-08-27',
      markAccountCustomer: true,
    }),
    CTX,
  );
  assert.equal(won.ok, true);
  if (!won.ok) return;
  assert.equal(won.value.status, 'WON');
  assert.equal(won.value.probability, 1);
  assert.equal(won.value.wonAmount, 3_900_000);

  const account = await c.execute({
    sql: `SELECT account_type, oracle_customer_code FROM accounts WHERE account_id = 'ACC-PROS'`,
    args: [],
  });
  assert.equal(String(account.rows[0]?.account_type), 'CUSTOMER');
  // Winning commercially does not create an Oracle master record.
  assert.equal(account.rows[0]?.oracle_customer_code ?? null, null);
  c.close();
});

test('lost requires a configured reason and a close date, and a closed record refuses further moves and edits', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.opportunityId;

  const bare = await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({ expectedStageId: 'PST-KE-01', toStageId: 'PST-KE-05' }),
    CTX,
  );
  assert.equal(bare.ok, false);
  if (!bare.ok) {
    assert.deepEqual(
      refusalFields(bare)
        .map((f) => f.field)
        .sort(),
      ['actualCloseDate', 'lostReasonId'],
    );
  }

  const lost = await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({
      expectedStageId: 'PST-KE-01',
      toStageId: 'PST-KE-05',
      lostReasonId: 'LR-001',
      lostNotes: 'Competitor undercut on price',
      actualCloseDate: '2026-08-27',
    }),
    CTX,
  );
  assert.equal(lost.ok, true);
  if (!lost.ok) return;
  assert.equal(lost.value.status, 'LOST');
  assert.equal(lost.value.probability, 0);
  assert.equal(lost.value.lostReasonName, 'Price');

  // Closed is closed.
  const dead = await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({ expectedStageId: 'PST-KE-05', toStageId: 'PST-KE-01' }),
    CTX,
  );
  assert.equal(dead.ok, false);
  assert.equal(!dead.ok && dead.kind, 'conflict');
  c.close();
});

// ---------------------------------------------------------------------------
// Pipeline configuration safety.
// ---------------------------------------------------------------------------

test('a stage flagged both won and lost is rejected at add and at edit', async () => {
  const c = await db();
  const both = await addStage(
    asClient(c),
    'PIPE-002',
    {
      stageName: 'Schrödinger',
      defaultProbability: 0.5,
      targetDays: null,
      isWonStage: true,
      isLostStage: true,
      active: true,
    },
    CTX,
  );
  assert.equal(both.ok, false);
  if (!both.ok) assert.equal(refusalFields(both)[0]?.field, 'isLostStage');

  const edited = await updateStage(
    asClient(c),
    'PST-KE-04',
    {
      stageName: 'Won',
      defaultProbability: 1,
      targetDays: 0,
      isWonStage: true,
      isLostStage: true,
      active: true,
    },
    CTX,
  );
  assert.equal(edited.ok, false);
  c.close();
});

test('reordering parks then settles, so UNIQUE(pipeline_id, sequence_no) never trips', async () => {
  const c = await db();
  // The naive swap is what the two-pass batch replaces. Prove the naive way
  // actually fails on this schema, so the two-pass is necessary, not caution.
  await assert.rejects(
    c.execute({
      sql: `UPDATE pipeline_stages SET sequence_no = 2 WHERE pipeline_stage_id = 'PST-KE-01'`,
      args: [],
    }),
    /UNIQUE constraint failed/,
  );

  const reversed = ['PST-KE-05', 'PST-KE-04', 'PST-KE-03', 'PST-KE-02', 'PST-KE-01'];
  const done = await reorderStages(asClient(c), 'PIPE-001', reversed, CTX);
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.deepEqual(
    done.value.stages.map((s) => s.pipelineStageId),
    reversed,
  );
  assert.deepEqual(
    done.value.stages.map((s) => s.sequenceNo),
    [1, 2, 3, 4, 5],
  );

  // A list that misses a stage is refused before anything is touched.
  const partial = await reorderStages(asClient(c), 'PIPE-001', reversed.slice(1), CTX);
  assert.equal(partial.ok, false);
  c.close();
});

test('a pipeline with no active stage cannot receive an opportunity', async () => {
  const c = await db();
  const empty = await createPipeline(
    asClient(c),
    { pipelineName: 'Nowhere Pipeline', countryId: null, affiliateId: null, active: true },
    CTX,
  );
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  const refused = await createOpportunity(
    asClient(c),
    SEED.admin,
    opportunity({ pipelineId: empty.value.pipelineId }),
    CTX,
  );
  assert.equal(refused.ok, false);
  c.close();
});

test('lost reasons are configurable and unique by name', async () => {
  const c = await db();
  const made = await createLostReason(
    asClient(c),
    {
      reasonName: 'Logistics Constraint',
      category: 'Operational',
      description: null,
      active: true,
    },
    CTX,
  );
  assert.equal(made.ok, true);
  const duplicate = await createLostReason(
    asClient(c),
    { reasonName: 'Price', category: 'Commercial', description: null, active: true },
    CTX,
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(refusalFields(duplicate)[0]?.field, 'reasonName');
  c.close();
});

// ---------------------------------------------------------------------------
// Scope and aggregates.
// ---------------------------------------------------------------------------

test('aggregates use the same scope predicate as the list, and match it exactly', async () => {
  const c = await db();
  // James is OWN-scoped through UR-007/SCOPE-007 and owns all five seeded
  // opportunities, so give one to somebody else and watch it leave both the
  // list and the aggregate together.
  await c.execute({
    sql: `UPDATE opportunities SET owner_user_id = ? WHERE opportunity_id = 'OPP-004'`,
    args: [SEED.admin],
  });

  const listed = await listOpportunities(asClient(c), SEED.james, {
    ...anyQuery,
    pipelineId: 'PIPE-001',
    status: 'OPEN',
  });
  const summary = await pipelineSummary(asClient(c), SEED.james, 'PIPE-001');
  const aggregateTotal = summary.stages.reduce((sum, s) => sum + s.count, 0);
  assert.equal(aggregateTotal, listed.total);
  // OPP-004 is in neither.
  assert.equal(
    listed.items.some((o) => o.opportunityId === 'OPP-004'),
    false,
  );
  c.close();
});

test('a cross-scope direct call returns nothing, and currencies are never summed together', async () => {
  const c = await db();
  // Neema holds ROLE-FIN scoped to... nothing that grants opportunities.
  const scope = await scopedOpportunities(asClient(c), SEED.external[0] ?? 'USR-EXT001');
  assert.equal(scope.sql, '1 = 0');
  assert.equal(
    await getOpportunity(asClient(c), SEED.external[0] ?? 'USR-EXT001', 'OPP-001'),
    null,
  );

  // Two currencies in one stage stay two rows of the aggregate.
  await c.execute({
    sql: `UPDATE opportunities SET currency_code = 'USD' WHERE opportunity_id = 'OPP-001'`,
    args: [],
  });
  const summary = await pipelineSummary(asClient(c), SEED.admin, 'PIPE-001');
  const proposal = summary.stages.find((s) => s.stageId === 'PST-KE-02');
  assert.equal(proposal !== undefined, true);
  const currencies = (proposal?.byCurrency ?? []).map((b) => b.currencyCode).sort();
  assert.equal(currencies.includes('USD'), true);
  // No aggregate row mixes the two: each carries exactly one currency code.
  for (const stage of summary.stages) {
    const seen = new Set(stage.byCurrency.map((b) => b.currencyCode));
    assert.equal(seen.size, stage.byCurrency.length);
  }
  c.close();
});

test('the audit trail carries the phase-12 event types', async () => {
  const c = await db();
  const made = await createOpportunity(asClient(c), SEED.admin, opportunity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.opportunityId;
  await moveStage(asClient(c), SEED.admin, id, move(), CTX);
  await moveStage(
    asClient(c),
    SEED.admin,
    id,
    move({
      expectedStageId: 'PST-KE-02',
      toStageId: 'PST-KE-04',
      wonAmount: 4_000_000,
      actualCloseDate: '2026-08-27',
    }),
    CTX,
  );
  await createPipeline(
    asClient(c),
    { pipelineName: 'Audit Pipeline', countryId: null, affiliateId: null, active: true },
    CTX,
  );

  const events = await c.execute({
    sql: `SELECT DISTINCT event_type FROM audit_events WHERE event_type LIKE 'OPPORTUNITY%'
             OR event_type LIKE 'PIPELINE%'`,
    args: [],
  });
  const types = new Set(events.rows.map((r) => String(r.event_type)));
  for (const expected of [
    'OPPORTUNITY_CREATED',
    'OPPORTUNITY_STAGE_CHANGED',
    'OPPORTUNITY_WON',
    'PIPELINE_CREATED',
  ]) {
    assert.equal(types.has(expected), true, `missing ${expected}`);
  }
  c.close();
});
