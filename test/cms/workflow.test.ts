/**
 * Workflow authority: the resolver, and the accountability it persists.
 *
 * Against the operator's own seed, so "Grace Atieno is the Uganda approver" is
 * a statement about the configuration this product will run against, not about
 * a fixture written to make a test pass. The five assignments with no authority
 * rule are the seeded ones, and the Kenya sales order escalation gap is the
 * real gap.
 *
 * The database is an isolated in-memory one built from the schema DDL, with
 * foreign keys on and every CHECK present. Nothing here points at hass-cms.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  productDimension,
  resolveApprovers,
  type Resolution,
  type ResolutionRequest,
  type TransactionLine,
} from '../../src/lib/cms/workflow/resolver.ts';
import {
  approvalThreshold,
  assignStage,
  instanceVersion,
  listAssignees,
  recordDecision,
  reResolveStage,
  startWorkflow,
  type TransactionContext,
} from '../../src/lib/cms/workflow/runtime.ts';
import {
  createRule,
  createAssignment,
  createWorkflowRole,
  getDefinition,
  listStages,
  newVersion,
  reorderStages,
  supersedeAssignment,
  updateDefinition,
  workflowOptions,
} from '../../src/lib/cms/repos/workflowAdmin.ts';

const NOW = new Date('2026-08-27T09:00:00Z');
const TODAY = '2026-08-27';
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

/** The workflow role and stage ids the seed carries. Read, never assumed. */
const SO_FINANCE = 'WROLE-SO-FIN';
const GROUP_FINANCE = 'WROLE-GFIN';
const CASE_RESOLVER = 'WROLE-CASE';
const KENYA_SO = 'WFD-001';
const FINANCE_STAGE = 'WST-001';

/** Fuel, and a lubricant, as order lines. Product ids come from the seed. */
const FUEL_LINE: TransactionLine = {
  productId: 'PROD-AGO',
  productCategoryId: 'PC-AGO',
  productGroupId: 'PG-FUEL',
  lineValue: 9_000_000,
};
const LUBE_LINE: TransactionLine = {
  productId: 'PROD-LUBE',
  productCategoryId: 'PC-LUBE',
  productGroupId: 'PG-LUB',
  lineValue: 200_000,
};

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof resolveApprovers>[0];

function salesOrder(overrides: Partial<ResolutionRequest> = {}): ResolutionRequest {
  return {
    processType: 'SALES_ORDER',
    workflowRoleId: SO_FINANCE,
    countryId: 'CTR-KE',
    affiliateId: 'AFF-KE',
    businessUnitId: null,
    amount: 9_000_000,
    currencyCode: 'KES',
    lines: [FUEL_LINE],
    eventDate: TODAY,
    ...overrides,
  };
}

const names = (resolution: Resolution): string[] =>
  resolution.outcome === 'resolved' ? resolution.approvers.map((a) => a.displayName) : [];

const assignmentIds = (resolution: Resolution): string[] =>
  resolution.outcome === 'resolved' ? resolution.approvers.map((a) => a.assignmentId) : [];

function context(overrides: Partial<TransactionContext> = {}): TransactionContext {
  return {
    processType: 'SALES_ORDER',
    countryId: 'CTR-KE',
    affiliateId: 'AFF-KE',
    businessUnitId: 'BU-RET',
    amount: 9_000_000,
    currencyCode: 'KES',
    lines: [FUEL_LINE],
    eventDate: TODAY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 8: the five cases, proved one at a time.
// ---------------------------------------------------------------------------

test('a Kenya Retail sales order resolves to the business unit approver, over the affiliate one', async () => {
  const c = await db();
  const resolution = await resolveApprovers(asClient(c), salesOrder({ businessUnitId: 'BU-RET' }));

  assert.equal(resolution.outcome, 'resolved');
  assert.deepEqual(names(resolution), ['Zuleika Omar']);
  assert.deepEqual(assignmentIds(resolution), ['WRA-002']);
  if (resolution.outcome === 'resolved') {
    assert.equal(resolution.scopeTier, 'BUSINESS_UNIT');
    assert.equal(resolution.approvers[0]?.ruleId, 'AAR-002');

    // Gabriel was eligible on his own terms and lost to the more specific
    // approver. The trace says so rather than leaving him looking chosen.
    const gabriel = resolution.trace.find((entry) => entry.assignmentId === 'WRA-001');
    assert.equal(gabriel?.eligible, false);
    assert.equal(gabriel?.rejection, 'lower_specificity_available');
  }
  c.close();
});

test('a Kenya C&I sales order with no business unit approver falls to the affiliate approver', async () => {
  const c = await db();
  const resolution = await resolveApprovers(asClient(c), salesOrder({ businessUnitId: 'BU-CI' }));

  assert.equal(resolution.outcome, 'resolved');
  assert.deepEqual(names(resolution), ['Gabriel Musembi']);
  assert.deepEqual(assignmentIds(resolution), ['WRA-001']);
  if (resolution.outcome === 'resolved') {
    assert.equal(resolution.scopeTier, 'AFFILIATE');
    assert.equal(resolution.approvers[0]?.ruleId, 'AAR-001');
  }
  c.close();
});

test('a Uganda sales order resolves to Grace Atieno, and never to Gabriel Musembi', async () => {
  const c = await db();
  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG', currencyCode: 'UGX' }),
  );

  assert.equal(resolution.outcome, 'resolved');
  assert.deepEqual(names(resolution), ['Grace Atieno']);
  assert.deepEqual(assignmentIds(resolution), ['WRA-003']);

  // The whole result, not only the first entry. "Never Gabriel" is a claim
  // about the entire answer.
  const body = JSON.stringify(resolution.outcome === 'resolved' ? resolution.approvers : []);
  assert.equal(body.includes('Gabriel'), false);
  assert.equal(body.includes(SEED.gabriel), false);

  // And Gabriel is in the trace as out of scope, which is why.
  const gabriel = resolution.trace.find((entry) => entry.assignmentId === 'WRA-001');
  assert.equal(gabriel?.rejection, 'scope_mismatch');
  c.close();
});

test('a stage configured for the group workflow role resolves group authority', async () => {
  const c = await db();
  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({
      processType: 'PURCHASE_ORDER',
      workflowRoleId: GROUP_FINANCE,
      amount: 300_000,
      currencyCode: 'USD',
      lines: [],
    }),
  );

  assert.equal(resolution.outcome, 'resolved');
  assert.deepEqual(names(resolution), ['Hassan Ali']);
  if (resolution.outcome === 'resolved') {
    assert.equal(resolution.scopeTier, 'GROUP');
    assert.equal(resolution.approvers[0]?.ruleId, 'AAR-004');
  }
  c.close();
});

test('a Kenya sales order of 90,000,000 KES exceeds every configured authority and raises a configuration exception', async () => {
  const c = await db();
  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', amount: 90_000_000 }),
  );

  // The seeded configuration has no escalation path for a sales order: AAR-004,
  // the only rule with no ceiling, covers PURCHASE_ORDER in USD. So the correct
  // outcome today is the exception, not a silent fall-through to somebody.
  assert.equal(resolution.outcome, 'exception');
  if (resolution.outcome === 'exception') {
    assert.equal(resolution.reason, 'no_authority_covers_transaction');
    const zuleika = resolution.trace.find((entry) => entry.assignmentId === 'WRA-002');
    const gabriel = resolution.trace.find((entry) => entry.assignmentId === 'WRA-001');
    assert.equal(zuleika?.rejection, 'no_rule_matched');
    assert.equal(gabriel?.rejection, 'no_rule_matched');
    assert.match(String(zuleika?.ruleNotes[0]), /exceeds the rule maximum of 25000000/);
    assert.match(String(gabriel?.ruleNotes[0]), /exceeds the rule maximum of 50000000/);
  }
  c.close();
});

test('the escalation path is configuration, not code: a group assignment configured through the repository resolves the same 90,000,000 order', async () => {
  const c = await db();

  // Exactly what an operator would do through the screens this phase builds: a
  // group-scoped assignment of the sales order finance role, with a rule
  // covering the band above the affiliate ceiling. No code changes.
  const assignment = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.hassan,
      scopeType: 'GROUP',
      countryId: null,
      affiliateId: null,
      businessUnitId: null,
      priority: 1,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(assignment.ok, true);
  if (!assignment.ok) return;

  const rule = await createRule(
    asClient(c),
    {
      assignmentId: assignment.value.assignmentId,
      processType: 'SALES_ORDER',
      currencyCode: 'KES',
      minAmount: 50_000_000.01,
      maxAmount: null,
      productGroupId: null,
      productCategoryId: null,
      rulePriority: 1,
      active: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    CTX,
  );
  assert.equal(rule.ok, true);

  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', amount: 90_000_000 }),
  );
  assert.equal(resolution.outcome, 'resolved');
  assert.deepEqual(names(resolution), ['Hassan Ali']);
  if (resolution.outcome === 'resolved') assert.equal(resolution.scopeTier, 'GROUP');

  // And the ordinary order still goes to the local approver. A group escalation
  // must not quietly take over the everyday case.
  const ordinary = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', amount: 9_000_000 }),
  );
  assert.deepEqual(names(ordinary), ['Zuleika Omar']);
  c.close();
});

// ---------------------------------------------------------------------------
// Section 6: an assignment with no authority rule is unrestricted, everywhere.
// ---------------------------------------------------------------------------

test('an assignment with no authority rule carries any amount: Grace Atieno approves 1,000 and 900,000,000 alike', async () => {
  const c = await db();
  const small = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG', amount: 1_000, currencyCode: 'UGX' }),
  );
  const enormous = await resolveApprovers(
    asClient(c),
    salesOrder({
      countryId: 'CTR-UG',
      affiliateId: 'AFF-UG',
      amount: 900_000_000,
      currencyCode: 'UGX',
    }),
  );

  assert.deepEqual(names(small), ['Grace Atieno']);
  assert.deepEqual(names(enormous), ['Grace Atieno']);
  if (small.outcome === 'resolved') {
    assert.equal(small.approvers[0]?.unrestricted, true);
    assert.equal(small.approvers[0]?.ruleId, null);
    assert.match(String(small.approvers[0]?.reason), /carries no authority rule/);
  }
  c.close();
});

test('the same rule applies to the second rule-less assignment: Amina Yusuf carries a purchase order of any value', async () => {
  const c = await db();
  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({
      processType: 'PURCHASE_ORDER',
      workflowRoleId: 'WROLE-CM',
      amount: 4_000_000_000,
      currencyCode: 'KES',
      lines: [],
    }),
  );
  assert.deepEqual(names(resolution), ['Amina Yusuf']);
  if (resolution.outcome === 'resolved') assert.equal(resolution.approvers[0]?.unrestricted, true);
  c.close();
});

test('adding a rule to a rule-less assignment restricts it from that moment', async () => {
  const c = await db();
  const before = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG', amount: 900_000_000 }),
  );
  assert.deepEqual(names(before), ['Grace Atieno']);

  await createRule(
    asClient(c),
    {
      assignmentId: 'WRA-003',
      processType: 'SALES_ORDER',
      currencyCode: null,
      minAmount: 0,
      maxAmount: 10_000_000,
      productGroupId: null,
      productCategoryId: null,
      rulePriority: 10,
      active: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    CTX,
  );

  const after = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG', amount: 900_000_000 }),
  );
  assert.equal(after.outcome, 'exception');
  const within = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG', amount: 5_000_000 }),
  );
  assert.deepEqual(names(within), ['Grace Atieno']);
  c.close();
});

// ---------------------------------------------------------------------------
// Section 5a: the product dimension, and an order spanning two groups.
// ---------------------------------------------------------------------------

test('the product dimension of a set of lines is the distinct set, and it knows when it spans groups', () => {
  const one = productDimension([FUEL_LINE]);
  assert.deepEqual(one.groupIds, ['PG-FUEL']);
  assert.equal(one.spansGroups, false);

  const two = productDimension([FUEL_LINE, LUBE_LINE]);
  assert.deepEqual(two.groupIds, ['PG-FUEL', 'PG-LUB']);
  assert.equal(two.spansGroups, true);

  const none = productDimension([]);
  assert.equal(none.empty, true);
  assert.equal(none.spansGroups, false);
});

test('an order whose lines span two product groups does not match a rule restricted to one of them', async () => {
  const c = await db();

  // The same order, the same amount, the same approvers configured. The only
  // difference is a second line in a different group.
  const fuelOnly = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', lines: [FUEL_LINE] }),
  );
  assert.deepEqual(names(fuelOnly), ['Zuleika Omar']);

  const mixed = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', lines: [FUEL_LINE, LUBE_LINE] }),
  );

  // Neither Zuleika's rule nor Gabriel's covers lubricants, and this product
  // requires the rule to contain every line, so neither carries the order.
  assert.equal(mixed.outcome, 'exception');
  if (mixed.outcome === 'exception') {
    const zuleika = mixed.trace.find((entry) => entry.assignmentId === 'WRA-002');
    assert.equal(zuleika?.rejection, 'no_rule_matched');
    assert.match(String(zuleika?.ruleNotes[0]), /also carries PG-LUB/);
  }
  c.close();
});

test('a mixed order resolves to an approver whose authority carries no product restriction', async () => {
  const c = await db();
  const assignment = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.hassan,
      scopeType: 'AFFILIATE',
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      businessUnitId: null,
      priority: 50,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(assignment.ok, true);
  if (!assignment.ok) return;

  await createRule(
    asClient(c),
    {
      assignmentId: assignment.value.assignmentId,
      processType: 'SALES_ORDER',
      currencyCode: 'KES',
      minAmount: 0,
      maxAmount: null,
      productGroupId: null,
      productCategoryId: null,
      rulePriority: 50,
      active: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    CTX,
  );

  const mixed = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', lines: [FUEL_LINE, LUBE_LINE] }),
  );
  assert.deepEqual(names(mixed), ['Hassan Ali']);
  c.close();
});

test('a product-restricted rule does not match a transaction with no lines at all', async () => {
  const c = await db();
  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ businessUnitId: 'BU-RET', lines: [] }),
  );
  assert.equal(resolution.outcome, 'exception');
  if (resolution.outcome === 'exception') {
    const zuleika = resolution.trace.find((entry) => entry.assignmentId === 'WRA-002');
    assert.match(String(zuleika?.ruleNotes[0]), /carries no lines to test/);
  }
  c.close();
});

// ---------------------------------------------------------------------------
// Effective dating, priority, and overlapping assignments.
// ---------------------------------------------------------------------------

test('an assignment outside its effective window is not eligible, on either side of the boundary', async () => {
  const c = await db();

  const ended = await supersedeAssignment(
    asClient(c),
    'WRA-003',
    { effectiveTo: '2026-06-30', active: true },
    CTX,
  );
  assert.equal(ended.ok, true);

  const uganda = (date: string) =>
    resolveApprovers(
      asClient(c),
      salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG', eventDate: date }),
    );

  // The last day inside the window, and the first day outside it.
  assert.deepEqual(names(await uganda('2026-06-30')), ['Grace Atieno']);
  assert.equal((await uganda('2026-07-01')).outcome, 'exception');

  // And before it started, using the seeded start of 2026-01-01.
  assert.equal((await uganda('2025-12-31')).outcome, 'exception');
  assert.deepEqual(names(await uganda('2026-01-01')), ['Grace Atieno']);
  c.close();
});

test('two assignments tied on scope, priority and rule priority are both returned, in a stable order', async () => {
  const c = await db();

  // A second affiliate approver for Uganda, with the identical priority Grace
  // holds. Neither is more specific, neither has a rule, so both are eligible.
  const twin = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.daniel,
      scopeType: 'AFFILIATE',
      countryId: 'CTR-UG',
      affiliateId: 'AFF-UG',
      businessUnitId: null,
      priority: 10,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(twin.ok, true);

  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG' }),
  );
  assert.equal(resolution.outcome, 'resolved');
  assert.equal(names(resolution).length, 2);
  assert.deepEqual([...names(resolution)].sort(), ['Daniel Okello', 'Grace Atieno']);

  // Stable, so a sequential or round robin stage is deterministic: assignment
  // id ascending, and WRA-003 sorts before any newly generated WRA- id.
  const ids = assignmentIds(resolution);
  assert.deepEqual([...ids].sort(), ids);

  // A lower priority breaks the tie outright.
  const sharpened = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.neema,
      scopeType: 'AFFILIATE',
      countryId: 'CTR-UG',
      affiliateId: 'AFF-UG',
      businessUnitId: null,
      priority: 5,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(sharpened.ok, true);
  const decided = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG' }),
  );
  assert.deepEqual(names(decided), ['Neema Hassan']);
  c.close();
});

test('two overlapping effective assignments for one person and role collapse to the later start', async () => {
  const c = await db();

  // A delegation that was never closed out: Grace holds Uganda from January,
  // and a second row starting in July with a different priority.
  const later = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.grace,
      scopeType: 'AFFILIATE',
      countryId: 'CTR-UG',
      affiliateId: 'AFF-UG',
      businessUnitId: null,
      priority: 90,
      effectiveFrom: '2026-07-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(later.ok, true);
  if (!later.ok) return;

  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG' }),
  );
  assert.equal(resolution.outcome, 'resolved');

  // One Grace, not two. Counting her twice would double her in an ALL stage.
  assert.deepEqual(names(resolution), ['Grace Atieno']);
  assert.deepEqual(assignmentIds(resolution), [later.value.assignmentId]);

  const superseded = resolution.trace.find((entry) => entry.assignmentId === 'WRA-003');
  assert.equal(superseded?.rejection, 'superseded_by_later_assignment');
  c.close();
});

test('a suspended user holds no authority, whatever their assignment says', async () => {
  const c = await db();
  await c.execute({
    sql: `UPDATE users SET status = 'SUSPENDED' WHERE user_id = ?`,
    args: [SEED.grace],
  });
  const resolution = await resolveApprovers(
    asClient(c),
    salesOrder({ countryId: 'CTR-UG', affiliateId: 'AFF-UG' }),
  );
  assert.equal(resolution.outcome, 'exception');
  c.close();
});

// ---------------------------------------------------------------------------
// Leads, opportunities and cases: rules cannot name them, so they are not used.
// ---------------------------------------------------------------------------

test('a case resolves on assignment and scope alone, because approval_authority_rules cannot carry CASE', async () => {
  const c = await db();
  const resolution = await resolveApprovers(asClient(c), {
    processType: 'CASE',
    workflowRoleId: CASE_RESOLVER,
    countryId: 'CTR-KE',
    affiliateId: 'AFF-KE',
    businessUnitId: null,
    amount: null,
    currencyCode: null,
    lines: [],
    eventDate: TODAY,
  });
  assert.deepEqual(names(resolution), ['Catherine Mwangi']);
  if (resolution.outcome === 'resolved') {
    assert.equal(resolution.approvers[0]?.unrestricted, true);
    assert.match(String(resolution.approvers[0]?.reason), /cannot carry an authority rule/);
  }
  c.close();
});

test('an OTHER rule on the same assignment does not restrict a case', async () => {
  const c = await db();

  // A rule the operator wrote for a genuinely other process. Mapping a case
  // onto OTHER would make this silently restrict case resolution.
  await createRule(
    asClient(c),
    {
      assignmentId: 'WRA-010',
      processType: 'OTHER',
      currencyCode: 'KES',
      minAmount: 0,
      maxAmount: 1,
      productGroupId: null,
      productCategoryId: null,
      rulePriority: 10,
      active: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    CTX,
  );

  const resolution = await resolveApprovers(asClient(c), {
    processType: 'CASE',
    workflowRoleId: CASE_RESOLVER,
    countryId: 'CTR-KE',
    affiliateId: 'AFF-KE',
    businessUnitId: null,
    amount: 5_000_000,
    currencyCode: 'KES',
    lines: [],
    eventDate: TODAY,
  });
  assert.deepEqual(names(resolution), ['Catherine Mwangi']);
  c.close();
});

// ---------------------------------------------------------------------------
// Section 10: accountability is persisted once.
// ---------------------------------------------------------------------------

async function started(
  c: TestClient,
  overrides: Partial<TransactionContext> = {},
): Promise<{ workflowInstanceId: string; stageInstanceId: string }> {
  const result = await startWorkflow(
    asClient(c),
    {
      workflowDefinitionId: KENYA_SO,
      entityType: 'SALES_ORDER',
      entityId: 'SO-TEST-0001',
      context: context(overrides),
    },
    CTX,
  );
  assert.notEqual(result, null);
  if (result === null) throw new Error('unreachable');
  assert.equal(result.first.ok, true);
  if (!result.first.ok) throw new Error('unreachable');
  return {
    workflowInstanceId: result.workflowInstanceId,
    stageInstanceId: result.first.stageInstanceId,
  };
}

test('a stage instance persists its approvers with the assignment that made each eligible', async () => {
  const c = await db();
  const { stageInstanceId } = await started(c);

  const rows = query(
    c,
    `SELECT user_id, workflow_role_assignment_id, sequence_no, required, status, notes
     FROM workflow_stage_assignees WHERE workflow_stage_instance_id = ?`,
    stageInstanceId,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.user_id, SEED.zuleika);
  assert.equal(rows[0]?.workflow_role_assignment_id, 'WRA-002');
  assert.equal(rows[0]?.status, 'ACTIVE');
  assert.match(String(rows[0]?.notes), /business unit BU-RET/);

  const audit = query(
    c,
    `SELECT event_type, actor_user_id, entity_id, after_json FROM audit_events
     WHERE event_type = 'APPROVER_RESOLVED'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.actor_user_id, SEED.admin);
  assert.equal(audit[0]?.entity_id, stageInstanceId);
  assert.match(String(audit[0]?.after_json), /WRA-002/);
  assert.match(String(audit[0]?.after_json), /AAR-002/);
  c.close();
});

test('loading a started stage twice returns the same assignees, with the configuration changed in between', async () => {
  const c = await db();
  const { workflowInstanceId, stageInstanceId } = await started(c);

  const first = await listAssignees(asClient(c), stageInstanceId);
  assert.deepEqual(
    first.map((a) => a.userId),
    [SEED.zuleika],
  );

  // The change an operator might make halfway through: Zuleika's assignment is
  // ended and somebody else takes the business unit.
  await supersedeAssignment(
    asClient(c),
    'WRA-002',
    { effectiveTo: '2026-08-01', active: false },
    CTX,
  );
  const replacement = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.victor,
      scopeType: 'BUSINESS_UNIT',
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      businessUnitId: 'BU-RET',
      priority: 20,
      effectiveFrom: '2026-08-02',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(replacement.ok, true);

  // The resolver, asked afresh, now says Victor.
  const fresh = await resolveApprovers(asClient(c), salesOrder({ businessUnitId: 'BU-RET' }));
  assert.deepEqual(names(fresh), ['Victor Njoroge']);

  // The started stage does not care, and that is the point.
  const second = await listAssignees(asClient(c), stageInstanceId);
  assert.deepEqual(
    second.map((a) => a.userId),
    [SEED.zuleika],
  );
  assert.deepEqual(
    second.map((a) => a.workflowRoleAssignmentId),
    ['WRA-002'],
  );

  // Asking to assign the same stage again returns what is there, and writes
  // nothing new.
  const again = await assignStage(
    asClient(c),
    { workflowInstanceId, workflowStageId: FINANCE_STAGE, context: context() },
    CTX,
  );
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.alreadyAssigned, true);
    assert.deepEqual(
      again.assignees.map((a) => a.userId),
      [SEED.zuleika],
    );
  }
  assert.equal(query(c, `SELECT COUNT(*) AS n FROM workflow_stage_assignees`)[0]?.n, 1);
  c.close();
});

test('re-resolution is deliberate, audited, and keeps the decisions that were already made', async () => {
  const c = await db();
  const { stageInstanceId } = await started(c);

  await supersedeAssignment(
    asClient(c),
    'WRA-002',
    { effectiveTo: '2026-08-01', active: false },
    CTX,
  );
  await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.victor,
      scopeType: 'BUSINESS_UNIT',
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      businessUnitId: 'BU-RET',
      priority: 20,
      effectiveFrom: '2026-08-02',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );

  const result = await reResolveStage(asClient(c), stageInstanceId, context(), CTX);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.assignees.map((a) => a.userId),
      [SEED.victor],
    );
  }

  const audit = query(
    c,
    `SELECT action, before_json, after_json FROM audit_events
     WHERE event_type = 'APPROVER_RESOLVED' AND action = 'RE_RESOLVE'`,
  );
  assert.equal(audit.length, 1);
  assert.match(String(audit[0]?.before_json), new RegExp(SEED.zuleika));
  assert.match(String(audit[0]?.after_json), new RegExp(SEED.victor));
  c.close();
});

// ---------------------------------------------------------------------------
// Section 9: the approval modes.
// ---------------------------------------------------------------------------

/** Put a second approver alongside Zuleika, so ALL and SEQUENTIAL have work. */
async function twoApprovers(c: TestClient): Promise<void> {
  const second = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.victor,
      scopeType: 'BUSINESS_UNIT',
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      businessUnitId: 'BU-RET',
      priority: 20,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await createRule(
    asClient(c),
    {
      assignmentId: second.value.assignmentId,
      processType: 'SALES_ORDER',
      currencyCode: 'KES',
      minAmount: 0,
      maxAmount: 25_000_000,
      productGroupId: 'PG-FUEL',
      productCategoryId: null,
      rulePriority: 20,
      active: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    CTX,
  );
}

async function setMode(c: TestClient, mode: string, required = 1): Promise<void> {
  await c.execute({
    sql: `UPDATE workflow_stages SET approval_mode = ?, required_approvals = ?
          WHERE workflow_stage_id = ?`,
    args: [mode, required, FINANCE_STAGE],
  });
}

test('the threshold is decided once, from the mode and the required count together', () => {
  assert.equal(approvalThreshold('ANY_ONE', 1, 3), 1);
  assert.equal(approvalThreshold('ANY_ONE', 2, 3), 2);
  assert.equal(approvalThreshold('ALL', 1, 3), 3);
  assert.equal(approvalThreshold('ALL', 9, 3), 3);
  assert.equal(approvalThreshold('SEQUENTIAL', 1, 2), 2);
  assert.equal(approvalThreshold('ROUND_ROBIN', 5, 1), 1);
  assert.equal(approvalThreshold('SYSTEM', 1, 0), 0);
});

test('ANY_ONE: one approval from either eligible approver completes the stage', async () => {
  const c = await db();
  await twoApprovers(c);
  await setMode(c, 'ANY_ONE');
  const { stageInstanceId } = await started(c);

  const assignees = await listAssignees(asClient(c), stageInstanceId);
  assert.equal(assignees.length, 2);
  // Nobody is individually required: the stage is offered to both.
  assert.deepEqual(
    assignees.map((a) => a.required),
    [false, false],
  );

  const decision = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: 'Within my authority.' },
    { ...CTX, actorUserId: SEED.victor },
  );
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.stageStatus, 'APPROVED');
    assert.equal(decision.approvals, 1);
    assert.equal(decision.threshold, 1);
  }

  // The other approver is closed out rather than left with an open item.
  const after = await listAssignees(asClient(c), stageInstanceId);
  const other = after.find((a) => a.userId !== SEED.victor);
  assert.equal(other?.status, 'SKIPPED');
  c.close();
});

test('ALL: the stage stays open until every assignee has approved', async () => {
  const c = await db();
  await twoApprovers(c);
  await setMode(c, 'ALL');
  const { stageInstanceId } = await started(c);

  const first = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: SEED.zuleika },
  );
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.stageStatus, 'ACTIVE');
    assert.equal(first.approvals, 1);
    assert.equal(first.threshold, 2);
  }

  const second = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: SEED.victor },
  );
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.stageStatus, 'APPROVED');

  const events = query(
    c,
    `SELECT event_type FROM audit_events WHERE event_type = 'APPROVAL_COMPLETED'`,
  );
  assert.equal(events.length, 2);
  c.close();
});

test('SEQUENTIAL: the second approver cannot act before the first', async () => {
  const c = await db();
  await twoApprovers(c);
  await setMode(c, 'SEQUENTIAL');
  const { stageInstanceId } = await started(c);

  const order = await listAssignees(asClient(c), stageInstanceId);
  assert.deepEqual(
    order.map((a) => a.sequenceNo),
    [1, 2],
  );
  assert.deepEqual(
    order.map((a) => a.status),
    ['ACTIVE', 'PENDING'],
  );
  const [firstUp, secondUp] = order;
  assert.notEqual(firstUp, undefined);
  assert.notEqual(secondUp, undefined);
  if (firstUp === undefined || secondUp === undefined) return;

  const outOfTurn = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: secondUp.userId },
  );
  assert.equal(outOfTurn.ok, false);
  if (!outOfTurn.ok) assert.equal(outOfTurn.kind, 'not_your_turn');

  const inTurn = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: firstUp.userId },
  );
  assert.equal(inTurn.ok, true);
  if (inTurn.ok) assert.equal(inTurn.stageStatus, 'ACTIVE');

  // Now it is the second approver's turn, and they were activated for it.
  const midway = await listAssignees(asClient(c), stageInstanceId);
  assert.equal(midway.find((a) => a.userId === secondUp.userId)?.status, 'ACTIVE');

  const finish = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: secondUp.userId },
  );
  assert.equal(finish.ok, true);
  if (finish.ok) assert.equal(finish.stageStatus, 'APPROVED');
  c.close();
});

test('ROUND_ROBIN persists exactly one approver, and the choice does not move on a reload', async () => {
  const c = await db();
  await twoApprovers(c);
  await setMode(c, 'ROUND_ROBIN');
  const { stageInstanceId } = await started(c);

  const chosen = await listAssignees(asClient(c), stageInstanceId);
  assert.equal(chosen.length, 1);
  const again = await listAssignees(asClient(c), stageInstanceId);
  assert.deepEqual(
    again.map((a) => a.userId),
    chosen.map((a) => a.userId),
  );

  // The next transaction goes to the one who has not had it, so the rotation is
  // fair rather than always landing on the same person.
  const next = await startWorkflow(
    asClient(c),
    {
      workflowDefinitionId: KENYA_SO,
      entityType: 'SALES_ORDER',
      entityId: 'SO-TEST-0002',
      context: context(),
    },
    CTX,
  );
  assert.notEqual(next, null);
  if (next === null || !next.first.ok) return;
  assert.equal(next.first.assignees.length, 1);
  assert.notEqual(next.first.assignees[0]?.userId, chosen[0]?.userId);
  c.close();
});

test('NAMED takes the person configured on the stage, with no authority resolution', async () => {
  const c = await db();
  // WFD-003's first stage is a NAMED stage assigned to a specific user, which
  // is the seed's own configuration, not one written here.
  const result = await startWorkflow(
    asClient(c),
    {
      workflowDefinitionId: 'WFD-003',
      entityType: 'LEAD',
      entityId: 'LEAD-TEST-0001',
      context: context({
        processType: 'LEAD',
        businessUnitId: 'BU-CI',
        amount: null,
        currencyCode: null,
        lines: [],
      }),
    },
    CTX,
  );
  assert.notEqual(result, null);
  if (result === null || !result.first.ok) return;
  assert.deepEqual(
    result.first.assignees.map((a) => a.userId),
    [SEED.james],
  );
  // A named stage records no workflow role assignment, because none was used.
  assert.equal(result.first.assignees[0]?.workflowRoleAssignmentId, null);
  c.close();
});

test('a SYSTEM stage completes with no human approver and no assignees', async () => {
  const c = await db();
  await c.execute({
    sql: `UPDATE workflow_stages
          SET assignment_type = 'SYSTEM', assigned_workflow_role_id = NULL,
              approval_mode = 'SYSTEM', required_approvals = 0
          WHERE workflow_stage_id = ?`,
    args: [FINANCE_STAGE],
  });

  const result = await startWorkflow(
    asClient(c),
    {
      workflowDefinitionId: KENYA_SO,
      entityType: 'SALES_ORDER',
      entityId: 'SO-TEST-SYSTEM',
      context: context(),
    },
    CTX,
  );
  assert.notEqual(result, null);
  if (result === null || !result.first.ok) return;
  assert.equal(result.first.assignees.length, 0);

  const stage = query(
    c,
    `SELECT status FROM workflow_stage_instances WHERE workflow_stage_instance_id = ?`,
    result.first.stageInstanceId,
  );
  assert.equal(stage[0]?.status, 'COMPLETED');
  c.close();
});

// ---------------------------------------------------------------------------
// Section 15: the failure mode.
// ---------------------------------------------------------------------------

test('a stage with no eligible approver assigns nobody, stays visible, and writes APPROVAL_EXCEPTION', async () => {
  const c = await db();

  const result = await startWorkflow(
    asClient(c),
    {
      workflowDefinitionId: KENYA_SO,
      entityType: 'SALES_ORDER',
      entityId: 'SO-TEST-EXCEPTION',
      // 90,000,000 exceeds every configured sales order authority.
      context: context({ amount: 90_000_000 }),
    },
    CTX,
  );
  assert.notEqual(result, null);
  if (result === null) return;
  assert.equal(result.first.ok, false);
  if (result.first.ok || result.first.kind !== 'exception') {
    assert.fail('expected a configuration exception');
    return;
  }

  const stageInstanceId = result.first.stageInstanceId;

  // Nobody was assigned. Not a random user, and not the system administrator.
  const assignees = query(
    c,
    `SELECT user_id FROM workflow_stage_assignees WHERE workflow_stage_instance_id = ?`,
    stageInstanceId,
  );
  assert.equal(assignees.length, 0);

  // The stage exists and is visible, rather than silently stalling with no
  // trace.
  const stage = query(
    c,
    `SELECT status, action_notes FROM workflow_stage_instances WHERE workflow_stage_instance_id = ?`,
    stageInstanceId,
  );
  assert.equal(stage[0]?.status, 'PENDING');
  assert.match(String(stage[0]?.action_notes), /Configuration exception/);

  // And the alert, naming the process, the entity, the workflow role and the
  // organisational context.
  const audit = query(
    c,
    `SELECT actor_user_id, entity_id, after_json FROM audit_events
     WHERE event_type = 'APPROVAL_EXCEPTION'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.entity_id, stageInstanceId);
  const after = String(audit[0]?.after_json);
  assert.match(after, /SALES_ORDER/);
  assert.match(after, /SO-TEST-EXCEPTION/);
  assert.match(after, new RegExp(SO_FINANCE));
  assert.match(after, /BU-RET/);
  assert.match(after, /90000000/);
  c.close();
});

// ---------------------------------------------------------------------------
// Section 17: authorisation to approve.
// ---------------------------------------------------------------------------

test('a person who is not an assignee cannot approve the stage', async () => {
  const c = await db();
  const { stageInstanceId } = await started(c);

  const refused = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: SEED.gabriel },
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.kind, 'not_an_assignee');

  // Nothing was recorded against anybody.
  const rows = query(
    c,
    `SELECT decision FROM workflow_stage_assignees WHERE workflow_stage_instance_id = ?`,
    stageInstanceId,
  );
  assert.deepEqual(
    rows.map((r) => r.decision),
    [null],
  );
  c.close();
});

test('a decision is recorded against the session, so it cannot be made on somebody else behalf', async () => {
  const c = await db();
  const { stageInstanceId } = await started(c);

  // The signature has no parameter for an approver. The acting user is the
  // write context, which the endpoint builds from the session, so there is
  // nowhere for a request body to put one.
  const decision = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: SEED.zuleika },
  );
  assert.equal(decision.ok, true);

  const row = query(
    c,
    `SELECT user_id, decision FROM workflow_stage_assignees
     WHERE workflow_stage_instance_id = ? AND acted_at IS NOT NULL`,
    stageInstanceId,
  );
  assert.equal(row.length, 1);
  assert.equal(row[0]?.user_id, SEED.zuleika);
  c.close();
});

test('an already-completed stage refuses a further decision', async () => {
  const c = await db();
  const { stageInstanceId } = await started(c);

  const first = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: SEED.zuleika },
  );
  assert.equal(first.ok, true);

  const again = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'REJECTED', notes: 'Changed my mind.' },
    { ...CTX, actorUserId: SEED.zuleika },
  );
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.kind, 'stage_not_active');
  c.close();
});

test('a rejection ends the stage and writes APPROVAL_REJECTED', async () => {
  const c = await db();
  await twoApprovers(c);
  await setMode(c, 'ALL');
  const { stageInstanceId } = await started(c);

  const rejected = await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'REJECTED', notes: 'Credit terms are not in order.' },
    { ...CTX, actorUserId: SEED.zuleika },
  );
  assert.equal(rejected.ok, true);
  if (rejected.ok) assert.equal(rejected.stageStatus, 'REJECTED');

  const events = query(
    c,
    `SELECT event_type FROM audit_events WHERE event_type = 'APPROVAL_REJECTED'`,
  );
  assert.equal(events.length, 1);

  // The other approver is not left holding a decision that cannot change
  // anything.
  const after = await listAssignees(asClient(c), stageInstanceId);
  assert.equal(after.find((a) => a.userId === SEED.victor)?.status, 'SKIPPED');
  c.close();
});

// ---------------------------------------------------------------------------
// Sections 11 and 12: definitions, stages, reordering and versioning.
// ---------------------------------------------------------------------------

test('a workflow instance created under version 1 still reports version 1 after version 2 exists', async () => {
  const c = await db();
  const { workflowInstanceId } = await started(c);

  const before = await instanceVersion(asClient(c), workflowInstanceId);
  assert.equal(before?.versionNo, 1);

  const created = await newVersion(
    asClient(c),
    KENYA_SO,
    { effectiveFrom: '2026-09-01', retirePrevious: true },
    CTX,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.versionNo, 2);
  assert.equal(created.value.workflowName, 'Kenya Sales Order Approval');

  // The stages came with it, so version 2 is a workable copy rather than an
  // empty shell.
  const stages = await listStages(asClient(c), created.value.workflowDefinitionId);
  assert.equal(stages.length, 3);

  // The instance is unchanged. This is the assertion section 19 asks for.
  const after = await instanceVersion(asClient(c), workflowInstanceId);
  assert.equal(after?.versionNo, 1);
  assert.equal(after?.workflowDefinitionId, KENYA_SO);

  const audit = query(
    c,
    `SELECT after_json FROM audit_events WHERE event_type = 'WORKFLOW_VERSION_CREATED'`,
  );
  assert.equal(audit.length, 1);
  assert.match(String(audit[0]?.after_json), /"versionNo":2/);
  c.close();
});

test('a definition with instances refuses a substantive edit, and still allows retirement', async () => {
  const c = await db();
  await started(c);

  const definition = await getDefinition(asClient(c), KENYA_SO);
  assert.notEqual(definition, null);
  if (definition === null) return;
  assert.equal(definition.instanceCount, 1);

  const renamed = await updateDefinition(
    asClient(c),
    KENYA_SO,
    {
      workflowName: 'Kenya Sales Order Approval (revised)',
      processType: definition.processType,
      countryId: definition.countryId,
      affiliateId: definition.affiliateId,
      businessUnitId: definition.businessUnitId,
      active: true,
      effectiveFrom: definition.effectiveFrom,
      effectiveTo: null,
    },
    CTX,
  );
  assert.equal(renamed.ok, false);
  if (!renamed.ok) {
    assert.equal(renamed.kind, 'conflict');
    assert.match(String(renamed.fields[0]?.message), /Create a new version/);
  }

  // Retiring it is not a change to what it meant, so it stays possible.
  const retired = await updateDefinition(
    asClient(c),
    KENYA_SO,
    {
      workflowName: definition.workflowName,
      processType: definition.processType,
      countryId: definition.countryId,
      affiliateId: definition.affiliateId,
      businessUnitId: definition.businessUnitId,
      active: false,
      effectiveFrom: definition.effectiveFrom,
      effectiveTo: '2026-09-01',
    },
    CTX,
  );
  assert.equal(retired.ok, true);
  c.close();
});

test('reordering stages survives the unique constraint that a naive swap would break', async () => {
  const c = await db();
  const before = await listStages(asClient(c), KENYA_SO);
  assert.deepEqual(
    before.map((s) => s.stageCode),
    ['FINANCE_APPROVAL', 'CREDIT_CHECK', 'LOADING'],
  );

  // The naive path, to show the constraint is real rather than theoretical.
  await assert.rejects(
    async () =>
      c.execute({
        sql: `UPDATE workflow_stages SET sequence_no = 2 WHERE workflow_stage_id = 'WST-001'`,
        args: [],
      }),
    /UNIQUE constraint failed/,
  );

  const reordered = await reorderStages(
    asClient(c),
    KENYA_SO,
    [
      { stageId: 'WST-002', sequenceNo: 1 },
      { stageId: 'WST-001', sequenceNo: 2 },
      { stageId: 'WST-003', sequenceNo: 3 },
    ],
    CTX,
  );
  assert.equal(reordered.ok, true);

  const after = await listStages(asClient(c), KENYA_SO);
  assert.deepEqual(
    after.map((s) => s.stageCode),
    ['CREDIT_CHECK', 'FINANCE_APPROVAL', 'LOADING'],
  );

  const audit = query(
    c,
    `SELECT action FROM audit_events WHERE event_type = 'WORKFLOW_STAGE_CHANGED' AND action = 'REORDER'`,
  );
  assert.equal(audit.length, 1);
  c.close();
});

test('a definition already in use refuses a reorder', async () => {
  const c = await db();
  await started(c);
  const refused = await reorderStages(
    asClient(c),
    KENYA_SO,
    [
      { stageId: 'WST-002', sequenceNo: 1 },
      { stageId: 'WST-001', sequenceNo: 2 },
      { stageId: 'WST-003', sequenceNo: 3 },
    ],
    CTX,
  );
  assert.equal(refused.ok, false);
  c.close();
});

// ---------------------------------------------------------------------------
// Configuration writes: the CHECK constraints, and the audit trail.
// ---------------------------------------------------------------------------

test('a GROUP assignment sends NULL for the columns the scope excludes', async () => {
  const c = await db();
  const created = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.hassan,
      scopeType: 'GROUP',
      // The browser sends what the form held. The repository drops them.
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      businessUnitId: 'BU-RET',
      priority: 1,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const row = query(
    c,
    `SELECT country_id, affiliate_id, business_unit_id FROM workflow_role_assignments
     WHERE workflow_role_assignment_id = ?`,
    created.value.assignmentId,
  );
  assert.equal(row[0]?.country_id, null);
  assert.equal(row[0]?.affiliate_id, null);
  assert.equal(row[0]?.business_unit_id, null);
  c.close();
});

test('creating a workflow role writes WORKFLOW_ROLE_CREATED, and a duplicate code is a conflict', async () => {
  const c = await db();
  const created = await createWorkflowRole(
    asClient(c),
    {
      roleCode: 'PO_COUNTRY_APPROVER',
      roleName: 'PO Country Approver',
      processType: 'PURCHASE_ORDER',
      description: 'Country level purchase order approval',
      active: true,
    },
    CTX,
  );
  assert.equal(created.ok, true);

  const audit = query(
    c,
    `SELECT actor_user_id, action FROM audit_events WHERE event_type = 'WORKFLOW_ROLE_CREATED'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.actor_user_id, SEED.admin);

  const duplicate = await createWorkflowRole(
    asClient(c),
    {
      roleCode: 'PO_COUNTRY_APPROVER',
      roleName: 'Another name',
      processType: null,
      description: null,
      active: true,
    },
    CTX,
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.kind, 'conflict');
  c.close();
});

test('every workflow audit event type this phase writes reaches audit_events with an actor', async () => {
  const c = await db();

  await createWorkflowRole(
    asClient(c),
    {
      roleCode: 'TEST_ROLE',
      roleName: 'Test Role',
      processType: 'OTHER',
      description: null,
      active: true,
    },
    CTX,
  );
  const assignment = await createAssignment(
    asClient(c),
    {
      workflowRoleId: SO_FINANCE,
      userId: SEED.hassan,
      scopeType: 'GROUP',
      countryId: null,
      affiliateId: null,
      businessUnitId: null,
      priority: 1,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.equal(assignment.ok, true);
  if (!assignment.ok) return;
  const rule = await createRule(
    asClient(c),
    {
      assignmentId: assignment.value.assignmentId,
      processType: 'SALES_ORDER',
      currencyCode: null,
      minAmount: 0,
      maxAmount: null,
      productGroupId: null,
      productCategoryId: null,
      rulePriority: 1,
      active: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    CTX,
  );
  assert.equal(rule.ok, true);

  await newVersion(
    asClient(c),
    KENYA_SO,
    { effectiveFrom: '2026-09-01', retirePrevious: false },
    CTX,
  );
  const { stageInstanceId } = await started(c);
  await recordDecision(
    asClient(c),
    stageInstanceId,
    { decision: 'APPROVED', notes: null },
    { ...CTX, actorUserId: SEED.zuleika },
  );

  const written = query(c, `SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`).map(
    (r) => String(r.event_type),
  );

  for (const expected of [
    'WORKFLOW_ROLE_CREATED',
    'WORKFLOW_ROLE_ASSIGNED',
    'AUTHORITY_RULE_CREATED',
    'WORKFLOW_VERSION_CREATED',
    'APPROVER_RESOLVED',
    'APPROVAL_COMPLETED',
  ]) {
    assert.equal(written.includes(expected), true, `${expected} was not written`);
  }

  // Every row names who did it.
  const anonymous = query(c, `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IS NULL`);
  assert.equal(anonymous[0]?.n, 0);
  c.close();
});

test('the workflow forms offer only live options, read from the tables', async () => {
  const c = await db();
  const options = await workflowOptions(asClient(c));

  assert.equal(options.workflowRoles.length, 6);
  assert.equal(options.productGroups.length, 5);
  // Categories carry their group, which is what lets the preview build lines.
  assert.equal(
    options.productCategories.every((category) => category.parentId !== null),
    true,
  );
  // External users are not offered as approvers.
  assert.equal(
    options.users.some((user) => SEED.external.includes(user.id as never)),
    false,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// No workflow_events table was created, and none is needed.
// ---------------------------------------------------------------------------

test('there is no workflow_events table', async () => {
  const c = await db();
  const tables = query(
    c,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow%' ORDER BY name`,
  ).map((r) => String(r.name));

  assert.deepEqual(tables, [
    'workflow_definitions',
    'workflow_instances',
    'workflow_role_assignments',
    'workflow_roles',
    'workflow_stage_assignees',
    'workflow_stage_instances',
    'workflow_stages',
  ]);
  assert.equal(tables.includes('workflow_events'), false);
  c.close();
});
