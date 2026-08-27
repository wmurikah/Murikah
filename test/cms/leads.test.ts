/**
 * Lead management: numbering, scope, BANT, and conversion that runs once.
 *
 * Against the operator's own seed, which carries five leads, five sources, five
 * campaigns and five pipelines, and one lead (LEAD-003) already CONVERTED with
 * its opportunity. So "converting twice produces one opportunity" is tested
 * against a lead that really is in that state, not one arranged for the test.
 *
 * PERM-034 and PERM-035 come from
 * docs/cms/crm/03_add_lead_permissions.sql, which the operator runs by hand, so
 * `grantLeadPermissions` inserts exactly what that script inserts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalFields } from './support/refusal.ts';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  ageInDays,
  convertLead,
  createLead,
  disqualifyLead,
  getLead,
  getQualification,
  leadIndicators,
  listLeads,
  qualifyLead,
  recordFirstContact,
  scopedLeads,
  updateLead,
  type LeadInput,
} from '../../src/lib/cms/repos/leadAdmin.ts';
import {
  generateNumber,
  isNumberCollision,
  NUMBER_ATTEMPTS,
  NUMBER_PREFIX,
  withGeneratedNumber,
} from '../../src/lib/cms/crm/numbering.ts';
import { validateQualification, validateLead } from '../../src/lib/cms/admin/leadInput.ts';

const NOW = new Date('2026-08-27T09:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const anyQuery = {
  search: '',
  status: null,
  leadSourceId: null,
  ownerUserId: null,
  businessUnitId: null,
  campaignId: null,
  capturedFrom: null,
  capturedTo: null,
  firstContact: 'all' as const,
  page: 1,
};

/** Exactly what docs/cms/crm/03_add_lead_permissions.sql does. */
async function grantLeadPermissions(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-034','CRM','LEADS','MANAGE','Edit, qualify, disqualify and convert leads'),
          ('PERM-035','CRM','LEAD_SOURCES','MANAGE','Create, edit and deactivate lead sources')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-034','PERM-035')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          VALUES ('RP-SAL-008','ROLE-SALES','PERM-034',1,CURRENT_TIMESTAMP)`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantLeadPermissions(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listLeads>[0];

const lead = (over: Partial<LeadInput> = {}): LeadInput => ({
  accountId: 'ACC-001',
  primaryContactId: null,
  leadSourceId: 'LS-002',
  campaignId: 'CMP-001',
  businessUnitId: 'BU-CI',
  ownerUserId: SEED.james,
  title: 'Bulk AGO enquiry from the coast',
  description: null,
  productInterest: 'AGO bulk supply',
  estimatedVolume: 40000,
  estimatedValue: 4600000,
  currencyCode: 'KES',
  capturedAt: '2026-08-20 08:00:00',
  ...over,
});

// ---------------------------------------------------------------------------
// The lead number.
// ---------------------------------------------------------------------------

test('a lead number is allocated server-side, and no payload can choose one', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  // LD-2026-xxxxxxxxxx: the year a human reads, then 40 bits of randomness.
  assert.match(made.value.leadNumber, /^LD-2026-[0-9a-f]{10}$/);

  // The validator has no leadNumber field at all, so sending one is inert.
  const withNumber = validateLead(
    {
      leadNumber: 'LD-2026-0001',
      leadSourceId: 'LS-002',
      ownerUserId: SEED.james,
      title: 'Trying to choose a number',
      capturedAt: '2026-08-20 08:00:00',
    },
    '2026-08-27',
  );
  assert.equal(withNumber.ok, true);
  if (withNumber.ok) {
    assert.equal('leadNumber' in withNumber.value, false);
  }
  c.close();
});

test('generated numbers do not repeat across many allocations', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20_000; i++) {
    seen.add(generateNumber(NUMBER_PREFIX.lead, NOW));
  }
  // 40 bits over 20,000 draws: a repeat is possible and would be handled by the
  // UNIQUE constraint anyway. This asserts the generator is not degenerate,
  // which is the failure that would actually matter.
  assert.equal(seen.size > 19_990, true, `only ${seen.size} distinct numbers`);
});

test('the number retry loop reacts to a collision on its own column and to nothing else', async () => {
  // A collision on lead_number: retried, and the second attempt is returned.
  let attempts = 0;
  const value = await withGeneratedNumber(NUMBER_PREFIX.lead, 'lead_number', NOW, async (n) => {
    attempts += 1;
    if (attempts === 1) throw new Error('UNIQUE constraint failed: leads.lead_number');
    return n;
  });
  assert.equal(attempts, 2);
  assert.match(value, /^LD-2026-/);

  // A foreign key failure is not a numbering problem, so it propagates on the
  // first attempt rather than being retried five times into a misleading error.
  let fkAttempts = 0;
  await assert.rejects(
    async () =>
      withGeneratedNumber(NUMBER_PREFIX.lead, 'lead_number', NOW, async () => {
        fkAttempts += 1;
        throw new Error('FOREIGN KEY constraint failed');
      }),
    /FOREIGN KEY/,
  );
  assert.equal(fkAttempts, 1);

  // A different column's uniqueness is somebody else's problem too.
  assert.equal(
    isNumberCollision(new Error('UNIQUE constraint failed: leads.lead_number'), 'lead_number'),
    true,
  );
  assert.equal(
    isNumberCollision(new Error('UNIQUE constraint failed: accounts.account_code'), 'lead_number'),
    false,
  );

  // And it gives up rather than looping for ever.
  let forever = 0;
  await assert.rejects(
    async () =>
      withGeneratedNumber(NUMBER_PREFIX.lead, 'lead_number', NOW, async () => {
        forever += 1;
        throw new Error('UNIQUE constraint failed: leads.lead_number');
      }),
    /Could not allocate a unique lead_number/,
  );
  assert.equal(forever, NUMBER_ATTEMPTS);
});

test('two leads created back to back both get a number, and the column is unique', async () => {
  const c = await db();
  const results = [];
  for (let i = 0; i < 25; i++) {
    results.push(await createLead(asClient(c), lead({ title: `Lead ${i}` }), CTX));
  }
  assert.equal(
    results.every((r) => r.ok),
    true,
  );
  const numbers = query(c, `SELECT lead_number FROM leads`).map((r) => String(r.lead_number));
  assert.equal(new Set(numbers).size, numbers.length);

  // The guarantee is the constraint, not the odds. Reusing a number is refused.
  await assert.rejects(
    async () =>
      c.execute({
        sql: `UPDATE leads SET lead_number = 'LD-2026-0001' WHERE lead_number <> 'LD-2026-0001'
              AND lead_id = (SELECT lead_id FROM leads WHERE lead_number <> 'LD-2026-0001' LIMIT 1)`,
        args: [],
      }),
    /UNIQUE constraint failed/,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Creation.
// ---------------------------------------------------------------------------

test('a lead is created against an existing account, carrying free-text product interest', async () => {
  const c = await db();
  const made = await createLead(
    asClient(c),
    lead({ productInterest: 'LPG for an industrial kitchen, maybe 2 tonnes a month' }),
    CTX,
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;

  assert.equal(made.value.accountName, 'BluePeak Transport Ltd');
  assert.equal(made.value.status, 'NEW');
  assert.equal(made.value.firstContactAt, null);
  // Free text, uncertain, and not attached to the product catalogue. That
  // precision belongs on the opportunity.
  assert.equal(made.value.productInterest, 'LPG for an industrial kitchen, maybe 2 tonnes a month');
  c.close();
});

test('a lead may be created with no account at all, and one with a contact from another account is refused', async () => {
  const c = await db();

  const prospect = await createLead(
    asClient(c),
    lead({ accountId: null, primaryContactId: null }),
    CTX,
  );
  assert.equal(prospect.ok, true);
  if (prospect.ok) assert.equal(prospect.value.accountId, null);

  // CON-001 belongs to ACC-001. Attaching it to a lead on ACC-002 is refused.
  const wrongContact = await createLead(
    asClient(c),
    lead({ accountId: 'ACC-002', primaryContactId: 'CON-001' }),
    CTX,
  );
  assert.equal(wrongContact.ok, false);
  if (!wrongContact.ok) {
    const fields = refusalFields(wrongContact);
    assert.equal(fields[0]?.field, 'primaryContactId');
    assert.match(String(fields[0]?.message), /different account/);
  }

  // A contact with no account chosen is refused too.
  const orphanContact = await createLead(
    asClient(c),
    lead({ accountId: null, primaryContactId: 'CON-001' }),
    CTX,
  );
  assert.equal(orphanContact.ok, false);
  c.close();
});

// ---------------------------------------------------------------------------
// First contact.
// ---------------------------------------------------------------------------

test('recording first contact sets the timestamp once and moves NEW to CONTACTED', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const first = await recordFirstContact(asClient(c), SEED.admin, made.value.leadId, CTX);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.notEqual(first.value.firstContactAt, null);
  assert.equal(first.value.status, 'CONTACTED');
  const stamped = first.value.firstContactAt;

  // A second call changes nothing: the UPDATE is conditional on IS NULL, so the
  // moment cannot be moved later by somebody clicking again.
  const later = await recordFirstContact(asClient(c), SEED.admin, made.value.leadId, {
    ...CTX,
    now: new Date('2026-08-28T09:00:00Z'),
  });
  assert.equal(later.ok, true);
  if (later.ok) assert.equal(later.value.firstContactAt, stamped);
  c.close();
});

test('recording a belated first contact never walks a later status backwards', async () => {
  const c = await db();
  // LEAD-003 is CONVERTED in the seed and already has a first contact.
  const before = await getLead(asClient(c), SEED.admin, 'LEAD-003');
  assert.equal(before?.status, 'CONVERTED');

  const result = await recordFirstContact(asClient(c), SEED.admin, 'LEAD-003', CTX);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, 'CONVERTED');
    assert.equal(result.value.firstContactAt, before?.firstContactAt);
  }
  c.close();
});

// ---------------------------------------------------------------------------
// BANT.
// ---------------------------------------------------------------------------

test('a BANT score of 6 and of minus 1 are both refused, and 0 and 5 are both accepted', () => {
  const base = { budgetScore: 3, authorityScore: 3, needScore: 3, timelineScore: 3 };

  const tooHigh = validateQualification({ ...base, budgetScore: 6 });
  assert.equal(tooHigh.ok, false);
  if (!tooHigh.ok) assert.equal(tooHigh.errors[0]?.field, 'budgetScore');

  const negative = validateQualification({ ...base, timelineScore: -1 });
  assert.equal(negative.ok, false);
  if (!negative.ok) assert.equal(negative.errors[0]?.field, 'timelineScore');

  const floor = validateQualification({
    budgetScore: 0,
    authorityScore: 0,
    needScore: 0,
    timelineScore: 0,
  });
  assert.equal(floor.ok, true);

  const ceiling = validateQualification({
    budgetScore: 5,
    authorityScore: 5,
    needScore: 5,
    timelineScore: 5,
  });
  assert.equal(ceiling.ok, true);

  // A fraction is not a score either.
  assert.equal(validateQualification({ ...base, needScore: 3.5 }).ok, false);
});

test('the database refuses an out-of-range score too, so the validator is not the only guard', async () => {
  const c = await db();
  await assert.rejects(
    async () =>
      c.execute({
        sql: `INSERT INTO lead_qualifications VALUES
              ('LQ-BAD','LEAD-001',6,3,3,3,NULL,'USR-CATH','2026-08-27 09:00:00')`,
        args: [],
      }),
    /CHECK constraint failed/,
  );
  c.close();
});

test('qualifying sets the status and creates no opportunity', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const before = query(c, `SELECT COUNT(*) AS n FROM opportunities`)[0]?.n;

  const qualified = await qualifyLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
    {
      budgetScore: 4,
      authorityScore: 4,
      needScore: 5,
      timelineScore: 3,
      qualificationNotes: 'Fleet renewal confirmed',
    },
    CTX,
  );
  assert.equal(qualified.ok, true);
  if (qualified.ok) assert.equal(qualified.value.status, 'QUALIFIED');

  // Nothing was created. Qualification is an assessment, not a decision to
  // pursue.
  assert.equal(query(c, `SELECT COUNT(*) AS n FROM opportunities`)[0]?.n, before);
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM opportunity_stage_history`)[0]?.n !== undefined,
    true,
  );

  const record = await getQualification(asClient(c), made.value.leadId);
  assert.equal(record?.total, 16);
  assert.equal(record?.qualifiedByUserId, SEED.admin);
  c.close();
});

// ---------------------------------------------------------------------------
// Disqualification.
// ---------------------------------------------------------------------------

test('disqualifying requires a reason and preserves the lead and its qualification', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  await qualifyLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
    { budgetScore: 2, authorityScore: 2, needScore: 2, timelineScore: 1, qualificationNotes: null },
    CTX,
  );

  const done = await disqualifyLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
    'Contract locked with a competitor for 18 months',
    CTX,
  );
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.equal(done.value.status, 'DISQUALIFIED');
    assert.match(String(done.value.disqualificationReason), /18 months/);
  }

  // The lead is still there, and so is its assessment.
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM leads WHERE lead_id = ?`, made.value.leadId)[0]?.n,
    1,
  );
  assert.notEqual(await getQualification(asClient(c), made.value.leadId), null);
  c.close();
});

// ---------------------------------------------------------------------------
// Conversion.
// ---------------------------------------------------------------------------

test('conversion without an account is refused, naming the account', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead({ accountId: null }), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const refused = await convertLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
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
  if (!refused.ok && refused.kind === 'invalid_reference') {
    assert.equal(refused.fields[0]?.field, 'accountId');
    assert.match(String(refused.fields[0]?.message), /needs an account/);
  }
  // And nothing was written.
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = ?`, made.value.leadId)[0]?.n,
    0,
  );
  c.close();
});

test('a double conversion produces exactly one opportunity', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const leadId = made.value.leadId;

  const convert = () =>
    convertLead(
      asClient(c),
      SEED.admin,
      leadId,
      {
        pipelineId: 'PIPE-001',
        initialStageId: null,
        ownerUserId: null,
        title: null,
        estimatedValue: null,
        currencyCode: null,
        estimatedCloseDate: '2026-11-30',
      },
      CTX,
    );

  const first = await convert();
  const second = await convert();
  const third = await convert();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  if (!first.ok || !second.ok || !third.ok) return;

  assert.equal(first.value.alreadyConverted, false);
  assert.equal(second.value.alreadyConverted, true);
  assert.equal(third.value.alreadyConverted, true);
  assert.equal(second.value.opportunityId, first.value.opportunityId);
  assert.equal(third.value.opportunityId, first.value.opportunityId);

  // The row count is the claim that matters.
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = ?`, leadId)[0]?.n,
    1,
  );
  assert.equal(
    query(
      c,
      `SELECT COUNT(*) AS n FROM opportunity_stage_history WHERE opportunity_id = ?`,
      first.value.opportunityId,
    )[0]?.n,
    1,
  );
  // And exactly one LEAD_CONVERTED audit row, not three.
  assert.equal(
    query(
      c,
      `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'LEAD_CONVERTED' AND entity_id = ?`,
      leadId,
    )[0]?.n,
    1,
  );
  c.close();
});

test('the seeded converted lead is recognised as converted and produces no second opportunity', async () => {
  const c = await db();
  // LEAD-003 arrives CONVERTED with its opportunity already in the seed.
  const before = query(c, `SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = 'LEAD-003'`)[0]
    ?.n;
  assert.equal(before, 1);

  const again = await convertLead(
    asClient(c),
    SEED.admin,
    'LEAD-003',
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
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value.alreadyConverted, true);
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = 'LEAD-003'`)[0]?.n,
    1,
  );
  c.close();
});

test('the converted opportunity carries the lead id, the pipeline stage and a history row', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const converted = await convertLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
    {
      pipelineId: 'PIPE-001',
      initialStageId: null,
      ownerUserId: null,
      title: null,
      estimatedValue: null,
      currencyCode: null,
      estimatedCloseDate: '2026-11-30',
    },
    CTX,
  );
  assert.equal(converted.ok, true);
  if (!converted.ok) return;

  const opportunity = query(
    c,
    `SELECT lead_id, account_id, pipeline_id, current_stage_id, probability, status, owner_user_id
     FROM opportunities WHERE opportunity_id = ?`,
    converted.value.opportunityId,
  )[0];
  assert.equal(opportunity?.lead_id, made.value.leadId);
  assert.equal(opportunity?.account_id, 'ACC-001');
  assert.equal(opportunity?.pipeline_id, 'PIPE-001');
  // The pipeline's lowest sequence stage, and its default probability, stored
  // as the fraction the CHECK requires.
  assert.equal(opportunity?.current_stage_id, 'PST-KE-01');
  assert.equal(opportunity?.probability, 0.2);
  assert.equal(opportunity?.status, 'OPEN');

  const history = query(
    c,
    `SELECT from_stage_id, to_stage_id, duration_in_previous_stage_minutes, changed_by_user_id
     FROM opportunity_stage_history WHERE opportunity_id = ?`,
    converted.value.opportunityId,
  );
  assert.equal(history.length, 1);
  // No previous stage, so no from-stage and no duration. Zero would claim it
  // moved instantly.
  assert.equal(history[0]?.from_stage_id, null);
  assert.equal(history[0]?.to_stage_id, 'PST-KE-01');
  assert.equal(history[0]?.duration_in_previous_stage_minutes, null);
  assert.equal(history[0]?.changed_by_user_id, SEED.admin);

  // The lead is closed out.
  const after = await getLead(asClient(c), SEED.admin, made.value.leadId);
  assert.equal(after?.status, 'CONVERTED');
  assert.equal(after?.opportunityId, converted.value.opportunityId);
  c.close();
});

test('a stage from another pipeline is refused', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const refused = await convertLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
    {
      pipelineId: 'PIPE-002',
      initialStageId: 'PST-KE-01',
      ownerUserId: null,
      title: null,
      estimatedValue: null,
      currencyCode: null,
      estimatedCloseDate: null,
    },
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok && refused.kind === 'invalid_reference') {
    assert.equal(refused.fields[0]?.field, 'initialStageId');
  }
  c.close();
});

test('a disqualified lead is not converted without being reopened', async () => {
  const c = await db();

  // Not one of the seeded leads: LEAD-005 is DISQUALIFIED, but it also already
  // carries OPP-005, so a convert on it returns the existing opportunity rather
  // than reaching the status guard. Every seeded lead has an opportunity, so the
  // only way to reach the guard is with a lead this test disqualifies itself.
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const stopped = await disqualifyLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
    'Current contract locked for 12 months',
    CTX,
  );
  assert.equal(stopped.ok, true);

  const refused = await convertLead(
    asClient(c),
    SEED.admin,
    made.value.leadId,
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
  assert.equal(refused.ok === false && refused.kind, 'conflict');
  if (!refused.ok && refused.kind === 'conflict') {
    assert.match(String(refused.fields[0]?.message), /disqualified/i);
  }

  // Nothing was written: no opportunity points at it.
  const trace = await c.execute({
    sql: 'SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = ?',
    args: [made.value.leadId],
  });
  assert.equal(Number(trace.rows[0]?.n), 0);
  c.close();
});

// ---------------------------------------------------------------------------
// Scope.
// ---------------------------------------------------------------------------

async function scopeTo(
  c: TestClient,
  userId: string,
  scopeType: string,
  column: 'country_id' | 'affiliate_id' | 'business_unit_id' | null,
  value: string | null,
): Promise<void> {
  // The insert may be ignored, because some seeded people already hold
  // ROLE-SALES: James does, as UR-007. So the row is read back rather than
  // assumed, and the scope below hangs off whichever assignment is really
  // there. Assuming the id is how this helper used to raise a foreign key
  // error on exactly the people the seed had already covered.
  await c.execute({
    sql: `INSERT OR IGNORE INTO user_roles (user_role_id, user_id, role_id, effective_from,
            effective_to, assigned_by_user_id, active)
          VALUES (?, ?, 'ROLE-SALES', '2026-01-01', NULL, ?, 1)`,
    args: [`UR-LEAD-${userId}`, userId, SEED.admin],
  });
  const assignment = await c.execute({
    sql: `SELECT user_role_id FROM user_roles
          WHERE user_id = ? AND role_id = 'ROLE-SALES' ORDER BY user_role_id LIMIT 1`,
    args: [userId],
  });
  const userRoleId = String(assignment.rows[0]?.user_role_id);
  const columns = { country_id: null, affiliate_id: null, business_unit_id: null } as Record<
    string,
    string | null
  >;
  if (column !== null) columns[column] = value;
  await c.execute({
    sql: `INSERT OR IGNORE INTO user_role_scopes (scope_id, user_role_id, scope_type,
            country_id, affiliate_id, business_unit_id, team_id)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    args: [
      `URS-LEAD-${userId}`,
      userRoleId,
      scopeType,
      columns.country_id,
      columns.affiliate_id,
      columns.business_unit_id,
    ],
  });
}

test('a lead with no account is not visible to everyone', async () => {
  const c = await db();

  // An orphan lead: no account, owned by James, in no business unit.
  const orphan = await createLead(
    asClient(c),
    lead({ accountId: null, businessUnitId: null, ownerUserId: SEED.james }),
    CTX,
  );
  assert.equal(orphan.ok, true);
  if (!orphan.ok) return;

  // Gabriel is scoped to the Kenya affiliate. The orphan has no account, so the
  // affiliate branch cannot reach it, and he is not the owner.
  await scopeTo(c, SEED.gabriel, 'AFFILIATE', 'affiliate_id', 'AFF-KE');
  const gabrielsLeads = await listLeads(asClient(c), SEED.gabriel, anyQuery);
  assert.equal(
    gabrielsLeads.items.some((l) => l.leadId === orphan.value.leadId),
    false,
  );
  assert.equal(await getLead(asClient(c), SEED.gabriel, orphan.value.leadId), null);

  // He does see the seeded leads, which have accounts in his affiliate. Without
  // this the test would pass for the wrong reason.
  assert.equal(gabrielsLeads.items.length > 0, true);

  // The predicate says why: the account branch is guarded by IS NOT NULL.
  const predicate = await scopedLeads(asClient(c), SEED.gabriel);
  assert.match(predicate.sql, /l\.account_id IS NOT NULL AND EXISTS/);
  assert.equal(/OR\s+sa\.affiliate_id IS NULL/.test(predicate.sql), false);

  // The owner reaches it, through the OWN branch.
  await scopeTo(c, SEED.james, 'OWN', null, null);
  assert.notEqual(await getLead(asClient(c), SEED.james, orphan.value.leadId), null);
  c.close();
});

test('a business-unit-scoped user sees only their unit', async () => {
  const c = await db();
  await scopeTo(c, SEED.zuleika, 'BUSINESS_UNIT', 'business_unit_id', 'BU-LUB');

  const listed = await listLeads(asClient(c), SEED.zuleika, anyQuery);
  assert.equal(listed.items.length > 0, true);
  assert.equal(
    listed.items.every((l) => l.businessUnitId === 'BU-LUB'),
    true,
  );

  // A lead in another unit is refused by direct id.
  const other = query(c, `SELECT lead_id FROM leads WHERE business_unit_id = 'BU-CI' LIMIT 1`)[0];
  assert.notEqual(other, undefined);
  assert.equal(await getLead(asClient(c), SEED.zuleika, String(other?.lead_id)), null);
  c.close();
});

test('a cross-affiliate direct call returns nothing, and the indicators agree with the list', async () => {
  const c = await db();
  // A Uganda account and a lead on it.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, country_id, affiliate_id,
            status, created_at, updated_at)
          VALUES ('ACC-UG-9','Kampala Fuels Ltd','CUSTOMER','CTR-UG','AFF-UG','ACTIVE',
                  '2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    args: [],
  });
  const ugandaLead = await createLead(
    asClient(c),
    lead({ accountId: 'ACC-UG-9', businessUnitId: null, ownerUserId: SEED.grace }),
    CTX,
  );
  assert.equal(ugandaLead.ok, true);
  if (!ugandaLead.ok) return;

  await scopeTo(c, SEED.gabriel, 'AFFILIATE', 'affiliate_id', 'AFF-KE');
  assert.equal(await getLead(asClient(c), SEED.gabriel, ugandaLead.value.leadId), null);

  const listed = await listLeads(asClient(c), SEED.gabriel, anyQuery);
  const indicators = await leadIndicators(asClient(c), SEED.gabriel);
  // The card and the list count the same set, through the same predicate.
  assert.equal(indicators.total, listed.total);
  assert.equal(indicators.total < Number(query(c, `SELECT COUNT(*) AS n FROM leads`)[0]?.n), true);
  c.close();
});

// ---------------------------------------------------------------------------
// Ageing, and audit.
// ---------------------------------------------------------------------------

test('ageing is a fact in days and never a judgement', () => {
  assert.equal(ageInDays('2026-08-20 09:00:00', new Date('2026-08-27T09:00:00Z')), 7);
  assert.equal(ageInDays('2026-08-27 09:00:00', new Date('2026-08-27T09:00:00Z')), 0);
  // A capture date in the future is not negative days.
  assert.equal(ageInDays('2026-09-01 09:00:00', new Date('2026-08-27T09:00:00Z')), 0);
  // Nothing in this module returns "stale" or "late": there is no configurable
  // threshold to judge against, so the only deterministic signal is whether
  // first contact has happened, which the indicators expose separately.
});

test('all seven lead audit event types are written with before and after state', async () => {
  const c = await db();
  const made = await createLead(asClient(c), lead(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const leadId = made.value.leadId;

  await recordFirstContact(asClient(c), SEED.admin, leadId, CTX);
  await updateLead(
    asClient(c),
    SEED.admin,
    leadId,
    lead({ title: 'Renamed', ownerUserId: SEED.victor }),
    CTX,
  );
  await qualifyLead(
    asClient(c),
    SEED.admin,
    leadId,
    { budgetScore: 4, authorityScore: 4, needScore: 4, timelineScore: 4, qualificationNotes: null },
    CTX,
  );
  await convertLead(
    asClient(c),
    SEED.admin,
    leadId,
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

  const other = await createLead(asClient(c), lead({ title: 'To disqualify' }), CTX);
  assert.equal(other.ok, true);
  if (other.ok) {
    await disqualifyLead(asClient(c), SEED.admin, other.value.leadId, 'No budget this year', CTX);
  }

  const written = query(c, `SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`).map(
    (r) => String(r.event_type),
  );
  for (const expected of [
    'LEAD_CREATED',
    'LEAD_UPDATED',
    'LEAD_OWNER_CHANGED',
    'LEAD_CONTACTED',
    'LEAD_QUALIFIED',
    'LEAD_DISQUALIFIED',
    'LEAD_CONVERTED',
  ]) {
    assert.equal(written.includes(expected), true, `${expected} was not written`);
  }

  const ownerChange = query(
    c,
    `SELECT before_json, after_json FROM audit_events WHERE event_type = 'LEAD_OWNER_CHANGED'`,
  )[0];
  assert.match(String(ownerChange?.before_json), new RegExp(SEED.james));
  assert.match(String(ownerChange?.after_json), new RegExp(SEED.victor));

  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IS NULL`)[0]?.n,
    0,
  );
  c.close();
});
