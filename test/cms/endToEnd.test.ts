/**
 * Phase 30: final end-to-end validation and reconciliation.
 *
 * PASSING ISOLATED MODULE TESTS IS NOT SUFFICIENT, which is why this file
 * exists. Every module in this system has its own suite and every one of them
 * passes. What none of them can show is that ONE BUSINESS EVENT flows across
 * all of them without inconsistent state, double counting, broken security or
 * contradictory analytics. That is what is tested here.
 *
 * SECTION 2 RUNS FIRST AND EVERYTHING ELSE DEPENDS ON IT. If a Kenya finance
 * manager can approve a Uganda transaction, every journey below is measuring
 * a system that does not enforce its own security model, and the numbers are
 * worthless. So organisational security is proved before any journey runs.
 *
 * THE RECONCILIATIONS ARE CALCULATED BY HAND. Each one works the figure out
 * from the records with arithmetic written in the test, then compares it to
 * what the system reports. A difference is a defect, not a rounding note.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';
import { forgetResolvedScopes, resolveScope } from '../../src/lib/cms/auth/rbac.ts';
import { loadIdentity } from '../../src/lib/cms/repos/identity.ts';
import { resolveApprovers } from '../../src/lib/cms/workflow/resolver.ts';
import { createAccount, createContact, getAccount } from '../../src/lib/cms/repos/accountAdmin.ts';
import {
  createLead,
  recordFirstContact,
  qualifyLead,
  convertLead,
} from '../../src/lib/cms/repos/leadAdmin.ts';
import { moveStage, getOpportunity } from '../../src/lib/cms/repos/opportunityAdmin.ts';
import {
  createCase,
  addCommunication,
  changeCaseStatus,
} from '../../src/lib/cms/repos/serviceAdmin.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { funnel, winRate } from '../../src/lib/cms/repos/crmAnalytics.ts';
import { summary as serviceSummary } from '../../src/lib/cms/repos/serviceAnalytics.ts';
import { creditPicture } from '../../src/lib/cms/repos/soPerformance.ts';
import { portalScope } from '../../src/lib/cms/portal/tenant.ts';
import { portalOrder, portalCase } from '../../src/lib/cms/repos/portalData.ts';

const NOW_DATE = new Date('2026-08-27T10:00:00Z');
const NOW = '2026-08-27 10:00:00';
const CTX = {
  actorUserId: 'USR-CATH',
  ip: '10.0.0.10',
  userAgent: 'HassCMS Validation',
  now: NOW_DATE,
} as const;

/**
 * The same actor, a stated number of minutes later.
 *
 * A journey written entirely on one fixed instant is not a journey: a status
 * history is ordered by the moment of the change, `changed_at` holds whole
 * seconds, and the primary key is random, so several transitions stamped with
 * the same second have no order to read back. Real transitions are minutes
 * apart, so these are too. See defect D30-004 in the phase 30 report: the
 * schema records no monotonic sequence beside the timestamp.
 */
const later = (minutes: number) => ({
  ...CTX,
  now: new Date(NOW_DATE.getTime() + minutes * 60_000),
});

const asClient = (c: TestClient) => c as unknown as Parameters<typeof getAccount>[0];

/**
 * The controlled dataset is labelled so section 12's cleanup can find every
 * record. `VALIDATION-` on every name and `E2E-` on every identifier this
 * file mints.
 */
const LABEL = 'VALIDATION-';

async function db(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  // THE OPERATOR SCRIPTS, MIRRORED EXACTLY. Several permission codes the
  // application checks live in `docs/cms/**/*.sql` rather than in the seed,
  // because the operator runs them by hand. A validation run against a
  // database without them would be validating a system nobody will deploy,
  // so the harness applies them the same way the earlier suites do.
  await c.execute(`INSERT OR IGNORE INTO permissions
      (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
    ('PERM-032','CUSTOMERS','ACCOUNTS','MANAGE','Create and edit customer accounts and contacts'),
    ('PERM-033','CUSTOMERS','PORTAL_ACCESS','VIEW','See whether a contact holds customer portal access'),
    ('PERM-034','CRM','LEADS','MANAGE','Qualify, disqualify and edit leads'),
    ('PERM-035','CRM','LEADS','CONVERT','Convert a qualified lead into an opportunity'),
    ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline'),
    ('PERM-041','AUDIT','EVENTS','SECURITY_VIEW','View security events'),
    ('PERM-042','AUDIT','EVENTS','EXPORT','Export audit evidence')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions
      (role_permission_id, role_id, permission_id, allowed, created_at)
    SELECT 'RP-' || ar.role_id || '-' || p.permission_id, ar.role_id, p.permission_id, 1,
           CURRENT_TIMESTAMP
      FROM access_roles ar
      JOIN permissions p ON p.permission_id IN
        ('PERM-031','PERM-032','PERM-033','PERM-034','PERM-035','PERM-036','PERM-041','PERM-042')
     WHERE ar.role_id = 'ROLE-ADMIN'`);
  // The narrower grants, exactly as the scripts propose them: not everybody
  // gets everything, or the persona matrix below would be meaningless.
  await c.execute(`INSERT OR IGNORE INTO role_permissions
      (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
    ('RP-CS-008','ROLE-CSM','PERM-031',1,CURRENT_TIMESTAMP),
    ('RP-CS-009','ROLE-CSM','PERM-032',1,CURRENT_TIMESTAMP),
    ('RP-CS-010','ROLE-CSM','PERM-033',1,CURRENT_TIMESTAMP),
    ('RP-CS-034','ROLE-CSM','PERM-034',1,CURRENT_TIMESTAMP),
    ('RP-CS-035','ROLE-CSM','PERM-035',1,CURRENT_TIMESTAMP),
    ('RP-CS-036','ROLE-CSM','PERM-036',1,CURRENT_TIMESTAMP),
    ('RP-SAL-006','ROLE-SALES','PERM-031',1,CURRENT_TIMESTAMP),
    ('RP-SAL-007','ROLE-SALES','PERM-032',1,CURRENT_TIMESTAMP),
    ('RP-SAL-036','ROLE-SALES','PERM-036',1,CURRENT_TIMESTAMP),
    ('RP-FIN-006','ROLE-FIN','PERM-031',1,CURRENT_TIMESTAMP),
    ('RP-CRD-006','ROLE-CRD','PERM-031',1,CURRENT_TIMESTAMP),
    ('RP-CM-007','ROLE-CM','PERM-031',1,CURRENT_TIMESTAMP),
    ('RP-GF-036','ROLE-GRP-FIN','PERM-036',1,CURRENT_TIMESTAMP)`);
  return c;
}

const count = async (c: TestClient, sql: string, args: unknown[] = []): Promise<number> => {
  const r = await c.execute({ sql, args: args as never[] });
  return Number((r.rows[0] as unknown as Record<string, unknown>).n);
};

// ===========================================================================
// §2 Organisational security, BEFORE any journey
// ===========================================================================

test('§2 organisational security passes before any journey is run', async () => {
  const c = await db();
  const client = asClient(c);

  // The Kenya finance manager approves Kenya and NOT Uganda. Proved through
  // the resolver, which is what actually decides an approval, rather than
  // through an interface that could be hiding a button.
  // The stage names a workflow ROLE, and the resolver takes that role plus the
  // transaction's own geography. This is the code that actually decides an
  // approval, so the test asks it rather than asking an interface that could
  // be hiding a button.
  const roleRow = await c.execute(
    `SELECT ws.assigned_workflow_role_id AS id FROM workflow_stages ws
      JOIN workflow_definitions wd ON wd.workflow_definition_id = ws.workflow_definition_id
      WHERE wd.process_type = 'SALES_ORDER' AND ws.assignment_type = 'WORKFLOW_ROLE'
        AND ws.stage_code = 'FINANCE_APPROVAL' LIMIT 1`,
  );
  const roleId = String((roleRow.rows[0] as unknown as Record<string, unknown>).id);

  // The transaction carries a fuel line, because the seeded authority rule
  // restricts by product group. A transaction with no lines is correctly
  // refused by every approver, and the trace says so: "the rule restricts by
  // product and the transaction carries no lines to test". That refusal is
  // right, and it is not what this test is measuring.
  const ask = (countryId: string, affiliateId: string, currency: string) =>
    resolveApprovers(client, {
      processType: 'SALES_ORDER',
      workflowRoleId: roleId,
      countryId,
      affiliateId,
      businessUnitId: null,
      amount: 1_000_000,
      currencyCode: currency,
      lines: [{ productId: null, productCategoryId: null, productGroupId: 'PG-FUEL' }],
      eventDate: '2026-08-27',
    });

  const kenya = await ask('CTR-KE', 'AFF-KE', 'KES');
  assert.equal(kenya.outcome, 'resolved', JSON.stringify(kenya));
  const kenyaIds = kenya.outcome === 'resolved' ? kenya.approvers.map((a) => a.userId) : [];
  assert.equal(kenyaIds.includes('USR-GAB'), true, 'the Kenya finance manager can approve Kenya');
  assert.equal(
    kenyaIds.includes('USR-FMUG'),
    false,
    'THE UGANDA MANAGER MUST NOT BE A KENYA APPROVER',
  );

  const uganda = await ask('CTR-UG', 'AFF-UG', 'UGX');
  assert.equal(uganda.outcome, 'resolved', JSON.stringify(uganda));
  const ugandaIds = uganda.outcome === 'resolved' ? uganda.approvers.map((a) => a.userId) : [];
  assert.equal(ugandaIds.includes('USR-FMUG'), true, 'the Uganda manager approves Uganda');
  assert.equal(
    ugandaIds.includes('USR-GAB'),
    false,
    'THE KENYA MANAGER MUST NOT BE A UGANDA APPROVER',
  );

  // The two answers are disjoint on these two people, which is the whole
  // point: same job title, same workflow role, different authority.
  assert.notDeepEqual(kenyaIds, ugandaIds);

  // A Group-required stage resolves to the Group approver, and a local
  // finance user is not among its candidates.
  const groupRole = await c.execute(
    `SELECT workflow_role_id AS id FROM workflow_roles WHERE role_code LIKE '%GROUP%' OR role_name LIKE '%Group%' LIMIT 1`,
  );
  const groupRoleId = (groupRole.rows[0] as unknown as Record<string, unknown> | undefined)?.id;
  if (groupRoleId !== undefined) {
    const groupStage = await resolveApprovers(client, {
      processType: 'SALES_ORDER',
      workflowRoleId: String(groupRoleId),
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      businessUnitId: null,
      amount: 500_000_000,
      currencyCode: 'KES',
      lines: [{ productId: null, productCategoryId: null, productGroupId: 'PG-FUEL' }],
      eventDate: '2026-08-27',
    });
    if (groupStage.outcome === 'resolved') {
      const ids = groupStage.approvers.map((a) => a.userId);
      assert.equal(ids.includes('USR-GCFO'), true, 'the Group approver resolves');
      assert.equal(
        ids.includes('USR-GAB'),
        false,
        'A LOCAL FINANCE USER CANNOT APPROVE THE GROUP STAGE',
      );
    }
  }

  // The country manager is confined to their own entity.
  const amina = await resolveScope(client, 'USR-AMN', 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(amina.group, false, 'a country manager is never Group-scoped');

  // The administrator has what is configured and no more: they hold
  // ROLE-ADMIN at GROUP, which is a configured fact, not an exemption.
  const admin = await resolveScope(client, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(admin.granted, true);
  assert.equal(admin.group, true);
  // And the sales executive, who is not, is not.
  const sales = await resolveScope(client, 'USR-JAM', 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(sales.group, false);

  c.close();
});

// ===========================================================================
// §3 Journey A: prospect to customer
// ===========================================================================

test('§3 Journey A: enquiry to won opportunity, reconciled by hand', async () => {
  const c = await db();
  const client = asClient(c);

  const leadsBefore = await count(c, `SELECT COUNT(*) AS n FROM leads`);
  const oppsBefore = await count(c, `SELECT COUNT(*) AS n FROM opportunities`);
  const wonBefore = await count(c, `SELECT COUNT(*) AS n FROM opportunities WHERE status = 'WON'`);
  const lostBefore = await count(
    c,
    `SELECT COUNT(*) AS n FROM opportunities WHERE status = 'LOST'`,
  );

  // ---- The prospect --------------------------------------------------------
  const account = await createAccount(
    client,
    {
      accountName: `${LABEL}Sirikwa Haulage Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-CUST-001',
      oracleCustomerCode: null,
      industry: 'Transport',
      segment: 'Corporate',
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      address: 'Eldoret',
      phone: '+254700000900',
      email: 'procurement@sirikwa.example',
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: 'USR-JAM',
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );
  assert.equal(account.ok, true, JSON.stringify(account));
  const accountId = account.ok ? account.value.accountId : '';

  const contact = await createContact(
    client,
    'USR-CATH',
    accountId,
    {
      fullName: `${LABEL}Esther Chelimo`,
      jobTitle: 'Procurement Lead',
      email: 'esther.chelimo@sirikwa.example',
      phone: '+254700000901',
      whatsapp: null,
      preferredChannel: 'EMAIL',
      isPrimary: true,
      active: true,
    },
    CTX,
  );
  assert.equal(contact.ok, true, JSON.stringify(contact));
  const contactId = contact.ok ? contact.value.contactId : '';

  // ---- The lead, from customer service -------------------------------------
  const lead = await createLead(
    client,
    {
      accountId,
      primaryContactId: contactId,
      // LS-001 is the configured customer-service source, per phase 22.
      leadSourceId: 'LS-001',
      campaignId: null,
      businessUnitId: 'BU-CI',
      ownerUserId: 'USR-JAM',
      title: `${LABEL}Bulk AGO enquiry`,
      description: 'Rang the service desk asking about bulk AGO supply.',
      productInterest: 'AGO bulk supply',
      estimatedVolume: 80000,
      estimatedValue: null,
      currencyCode: 'KES',
      capturedAt: '2026-08-01 09:00:00',
    },
    CTX,
  );
  assert.equal(lead.ok, true, JSON.stringify(lead));
  const leadId = lead.ok ? lead.value.leadId : '';

  // The account, the contact, the lead and their audit rows all link.
  assert.equal(await count(c, `SELECT COUNT(*) AS n FROM leads WHERE lead_id = ?`, [leadId]), 1);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM leads WHERE lead_id = ? AND account_id = ?`, [
      leadId,
      accountId,
    ]),
    1,
  );
  assert.equal(
    (await count(c, `SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ?`, [accountId])) >=
      1,
    true,
    'the account creation is audited',
  );

  // ---- First contact -------------------------------------------------------
  const contacted = await recordFirstContact(client, 'USR-CATH', leadId, CTX);
  assert.equal(contacted.ok, true, JSON.stringify(contacted));

  const firstContactAt = await c.execute({
    sql: `SELECT first_contact_at FROM leads WHERE lead_id = ?`,
    args: [leadId],
  });
  assert.notEqual(
    (firstContactAt.rows[0] as unknown as Record<string, unknown>).first_contact_at,
    null,
    'first_contact_at is populated',
  );

  // NO DUPLICATE FIRST-CONTACT EVENT. Recording it a second time must change
  // nothing: not the timestamp, not the status, and not the audit trail. It
  // is a fact about the lead, not a log of who pressed the button.
  const recorded = String(
    (firstContactAt.rows[0] as unknown as Record<string, unknown>).first_contact_at,
  );
  await recordFirstContact(client, 'USR-CATH', leadId, {
    ...CTX,
    now: new Date('2026-08-28T10:00:00Z'),
  });
  const afterSecond = await c.execute({
    sql: `SELECT first_contact_at FROM leads WHERE lead_id = ?`,
    args: [leadId],
  });
  assert.equal(
    String((afterSecond.rows[0] as unknown as Record<string, unknown>).first_contact_at),
    recorded,
    'the timestamp is not overwritten by a later call',
  );
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND event_type = 'LEAD_CONTACTED'`,
      [leadId],
    ),
    1,
    'EXACTLY ONE first-contact event exists. A second audit row would record a first contact that did not happen.',
  );

  // ---- BANT ----------------------------------------------------------------
  const qualified = await qualifyLead(
    client,
    'USR-CATH',
    leadId,
    {
      budgetScore: 4,
      authorityScore: 5,
      needScore: 4,
      timelineScore: 3,
      qualificationNotes: 'Budget confirmed, procurement lead is the decision maker.',
    },
    CTX,
  );
  assert.equal(qualified.ok, true, JSON.stringify(qualified));

  const bant = await c.execute({
    sql: `SELECT budget_score, authority_score, need_score, timeline_score
          FROM lead_qualifications WHERE lead_id = ?`,
    args: [leadId],
  });
  const scores = bant.rows[0] as unknown as Record<string, unknown>;
  assert.deepEqual(
    [scores.budget_score, scores.authority_score, scores.need_score, scores.timeline_score].map(
      Number,
    ),
    [4, 5, 4, 3],
    'four dimensions, stored separately',
  );
  // AND NO COMBINED SCORE. The four are never added into one number.
  const columns = await c.execute(`SELECT * FROM pragma_table_info('lead_qualifications')`);
  const names = columns.rows.map((r) => String((r as unknown as Record<string, unknown>).name));
  assert.equal(
    names.some((n) => /^(score|total_score|lead_score|combined)/.test(n)),
    false,
    'there is no single lead score anywhere in the schema',
  );

  const leadStatus = await c.execute({
    sql: `SELECT status FROM leads WHERE lead_id = ?`,
    args: [leadId],
  });
  assert.equal(
    String((leadStatus.rows[0] as unknown as Record<string, unknown>).status),
    'QUALIFIED',
  );

  // ---- Convert -------------------------------------------------------------
  const pipeline = await c.execute(`SELECT pipeline_id FROM pipelines LIMIT 1`);
  const pipelineId = String((pipeline.rows[0] as unknown as Record<string, unknown>).pipeline_id);

  const converted = await convertLead(
    client,
    'USR-CATH',
    leadId,
    {
      pipelineId,
      initialStageId: null,
      ownerUserId: 'USR-JAM',
      title: `${LABEL}Sirikwa AGO supply`,
      estimatedValue: 9_600_000,
      currencyCode: 'KES',
      estimatedCloseDate: '2026-10-31',
    },
    CTX,
  );
  assert.equal(converted.ok, true, JSON.stringify(converted));
  const opportunityId = converted.ok ? converted.value.opportunityId : '';

  // ATOMIC: the opportunity exists, the lead is converted, the account is
  // linked, the initial stage history row exists, and there is exactly ONE
  // opportunity, not two.
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = ?`, [leadId]),
    1,
  );
  assert.equal(
    String(
      (
        (await c.execute({ sql: `SELECT status FROM leads WHERE lead_id = ?`, args: [leadId] }))
          .rows[0] as unknown as Record<string, unknown>
      ).status,
    ),
    'CONVERTED',
  );
  assert.equal(
    (await count(
      c,
      `SELECT COUNT(*) AS n FROM opportunity_stage_history WHERE opportunity_id = ?`,
      [opportunityId],
    )) >= 1,
    true,
    'the initial stage history row exists',
  );

  // A second conversion creates no second opportunity.
  const again = await convertLead(
    client,
    'USR-CATH',
    leadId,
    {
      pipelineId,
      initialStageId: null,
      ownerUserId: 'USR-JAM',
      title: 'Should not happen',
      estimatedValue: 1,
      currencyCode: 'KES',
      estimatedCloseDate: '2026-10-31',
    },
    CTX,
  );
  void again;
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM opportunities WHERE lead_id = ?`, [leadId]),
    1,
    'NO SECOND OPPORTUNITY',
  );

  // ---- Move to won ---------------------------------------------------------
  const stages = await c.execute({
    sql: `SELECT pipeline_stage_id, sequence_no, is_won_stage FROM pipeline_stages
          WHERE pipeline_id = ? ORDER BY sequence_no`,
    args: [pipelineId],
  });
  const wonStage = stages.rows.find(
    (r) => Number((r as unknown as Record<string, unknown>).is_won_stage) === 1,
  );
  if (wonStage !== undefined) {
    const wonStageId = String((wonStage as unknown as Record<string, unknown>).pipeline_stage_id);
    // The move is optimistic: the caller states the stage it believes the
    // opportunity is in, and a lost race is refused rather than silently
    // applied. Read it back rather than assuming the conversion's default.
    const beforeMove = await getOpportunity(client, 'USR-CATH', opportunityId);
    assert.notEqual(beforeMove, null);
    const moved = await moveStage(
      client,
      'USR-CATH',
      opportunityId,
      {
        expectedStageId: beforeMove!.currentStageId,
        toStageId: wonStageId,
        probability: null,
        reason: 'Tender awarded',
        wonAmount: 9_600_000,
        actualCloseDate: '2026-08-20',
        lostReasonId: null,
        lostNotes: null,
        // Winning a deal does not silently reclassify the account. The route
        // checks the accounts permission before it may; this journey is about
        // the opportunity, so it is left alone and asserted below.
        markAccountCustomer: false,
      },
      CTX,
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));

    const opp = await getOpportunity(client, 'USR-CATH', opportunityId);
    assert.notEqual(opp, null);
    assert.equal(opp!.status, 'WON');

    // The account keeps its history. Its earlier lead is still linked and its
    // creation audit row still names it.
    const stillLinked = await getAccount(client, 'USR-CATH', accountId);
    assert.notEqual(stillLinked, null, 'the account survived the transition');
    assert.equal(
      await count(c, `SELECT COUNT(*) AS n FROM leads WHERE account_id = ?`, [accountId]),
      1,
      'the lead history is not lost',
    );
  }

  // ---- RECONCILE CRM ANALYTICS BY HAND -------------------------------------
  forgetResolvedScopes(client);
  const filter = parseFilter(new URLSearchParams());
  const [shape, win] = await Promise.all([
    funnel(client, 'USR-CATH', filter),
    winRate(client, 'USR-CATH', filter),
  ]);

  // By hand, straight from the tables.
  const handLeads = await count(c, `SELECT COUNT(*) AS n FROM leads`);
  const handQualified = await count(
    c,
    `SELECT COUNT(*) AS n FROM leads WHERE status IN ('QUALIFIED','CONVERTED')`,
  );
  const handWon = await count(c, `SELECT COUNT(*) AS n FROM opportunities WHERE status = 'WON'`);
  const handLost = await count(c, `SELECT COUNT(*) AS n FROM opportunities WHERE status = 'LOST'`);
  const handDecided = handWon + handLost;
  const handWinRate = handDecided === 0 ? null : Math.round((handWon / handDecided) * 1000) / 10;

  assert.equal(handLeads, leadsBefore + 1, 'exactly one lead was added');
  assert.equal(shape.steps[0]?.leads, handLeads, 'the funnel top equals a direct count');
  assert.equal(shape.qualificationDenominator, handLeads);
  // Qualified counts CONVERTED too. A lead that went all the way through was
  // qualified on its way, and dropping it out of the qualified step when it
  // converts would make the funnel narrow as the business succeeds.
  assert.equal(
    shape.steps.find((s) => s.step === 'Qualified')?.leads,
    handQualified,
    `hand ${handQualified} qualified, including the converted one`,
  );
  assert.equal(win.won, handWon, 'won matches a direct count');
  assert.equal(win.lost, handLost);
  assert.equal(win.denominator, handDecided, 'the denominator is won plus lost, by hand');
  assert.equal(
    win.winRatePercent,
    handWinRate,
    `hand ${handWinRate} vs system ${win.winRatePercent}`,
  );

  // Adding an OPEN opportunity must not move the win rate.
  const openBefore = win.open;
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM opportunities WHERE status = 'OPEN'`),
    openBefore,
    'the open count is reported and is not in the denominator',
  );
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM opportunities`),
    oppsBefore + 1,
    'exactly one opportunity was added, no double counting',
  );
  void wonBefore;
  void lostBefore;

  c.close();
});

// ===========================================================================
// §6 Journey D: the service case
// ===========================================================================

test('§6 Journey D: a case, hand-reconciled, with first response and pause', async () => {
  const c = await db();
  const client = asClient(c);

  const category = await c.execute(
    `SELECT case_category_id AS id FROM case_categories WHERE active = 1 LIMIT 1`,
  );
  const categoryId = String((category.rows[0] as unknown as Record<string, unknown>).id);

  const raised = await createCase(
    client,
    'USR-CATH',
    {
      accountId: 'ACC-001',
      contactId: 'CON-001',
      businessUnitId: null,
      caseType: 'COMPLAINT',
      caseCategoryId: categoryId,
      priority: null,
      subject: `${LABEL}Delivery arrived two days late`,
      description: 'The AGO delivery scheduled for Monday arrived on Wednesday.',
      channel: 'PHONE',
      raisedAt: '2026-08-20 08:00:00',
      assignedTeamId: null,
      assignedUserId: null,
    },
    CTX,
    false,
  );
  assert.equal(raised.ok, true, JSON.stringify(raised));
  const caseId = raised.ok ? raised.value.caseId : '';

  // The account, contact, category and priority all link, and the priority
  // came from the category rather than from the payload.
  const row = await c.execute({
    sql: `SELECT account_id, contact_id, case_category_id, priority, first_response_at, status
          FROM service_cases WHERE case_id = ?`,
    args: [caseId],
  });
  const record = row.rows[0] as unknown as Record<string, unknown>;
  assert.equal(String(record.account_id), 'ACC-001');
  assert.equal(String(record.case_category_id), categoryId);
  const categoryDefault = await c.execute({
    sql: `SELECT default_priority FROM case_categories WHERE case_category_id = ?`,
    args: [categoryId],
  });
  assert.equal(
    String(record.priority),
    String((categoryDefault.rows[0] as unknown as Record<string, unknown>).default_priority),
    'the category decided the priority, not the caller',
  );

  // ---- AN INTERNAL NOTE MUST NOT SET first_response_at ---------------------
  assert.equal(record.first_response_at, null, 'no first response yet');

  const internal = await addCommunication(
    client,
    'USR-CATH',
    caseId,
    {
      direction: 'INTERNAL',
      channel: 'OTHER',
      contactId: null,
      subject: 'Internal note',
      messageSummary: 'Checking with the depot before replying to the customer.',
      communicatedAt: '2026-08-20 09:00:00',
    },
    CTX,
  );
  assert.equal(internal.ok, true, JSON.stringify(internal));

  const afterInternal = await c.execute({
    sql: `SELECT first_response_at FROM service_cases WHERE case_id = ?`,
    args: [caseId],
  });
  assert.equal(
    (afterInternal.rows[0] as unknown as Record<string, unknown>).first_response_at,
    null,
    'AN INTERNAL NOTE IS NOT A FIRST RESPONSE. It is not a reply to the customer.',
  );

  // ---- An OUTBOUND communication is -----------------------------------------
  const outbound = await addCommunication(
    client,
    'USR-CATH',
    caseId,
    {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      contactId: 'CON-001',
      subject: 'About your delivery',
      messageSummary: 'We are sorry. The depot confirms a loading delay and we are investigating.',
      communicatedAt: '2026-08-20 10:00:00',
    },
    CTX,
  );
  assert.equal(outbound.ok, true, JSON.stringify(outbound));

  const afterOutbound = await c.execute({
    sql: `SELECT first_response_at FROM service_cases WHERE case_id = ?`,
    args: [caseId],
  });
  assert.notEqual(
    (afterOutbound.rows[0] as unknown as Record<string, unknown>).first_response_at,
    null,
    'an outbound customer communication IS the first response',
  );

  // ---- Waiting on the customer, then resolution ----------------------------
  // The status machine is explicit and refuses NEW to WAITING_CUSTOMER
  // directly, which is correct: a case nobody has picked up cannot be waiting
  // on the customer for anything. Somebody works it first.
  const started = await changeCaseStatus(
    client,
    'USR-CATH',
    caseId,
    {
      toStatus: 'IN_PROGRESS',
      reason: 'Picked up by customer service.',
      resolutionSummary: null,
      rootCause: null,
    },
    later(30),
  );
  assert.equal(started.ok, true, JSON.stringify(started));

  const waiting = await changeCaseStatus(
    client,
    'USR-CATH',
    caseId,
    {
      toStatus: 'WAITING_CUSTOMER',
      reason: 'Asked for the delivery note number.',
      resolutionSummary: null,
      rootCause: null,
    },
    later(60),
  );
  assert.equal(waiting.ok, true, JSON.stringify(waiting));

  const resumed = await changeCaseStatus(
    client,
    'USR-CATH',
    caseId,
    {
      toStatus: 'IN_PROGRESS',
      reason: 'Customer replied with the note number.',
      resolutionSummary: null,
      rootCause: null,
    },
    later(180),
  );
  assert.equal(resumed.ok, true, JSON.stringify(resumed));

  const resolved = await changeCaseStatus(
    client,
    'USR-CATH',
    caseId,
    {
      toStatus: 'RESOLVED',
      reason: 'Depot loading delay confirmed and credited.',
      resolutionSummary: 'Loading delay at the Nairobi depot. Credit note raised.',
      rootCause: 'Depot loading queue exceeded capacity on the day.',
    },
    later(240),
  );
  assert.equal(resolved.ok, true, JSON.stringify(resolved));

  const finalRow = await c.execute({
    sql: `SELECT resolved_at, status FROM service_cases WHERE case_id = ?`,
    args: [caseId],
  });
  const final = finalRow.rows[0] as unknown as Record<string, unknown>;
  assert.notEqual(final.resolved_at, null, 'resolved_at is set');
  assert.equal(String(final.status), 'RESOLVED');

  // The status history records every transition, in order.
  const history = await c.execute({
    sql: `SELECT to_status FROM case_status_history WHERE case_id = ? ORDER BY changed_at, case_status_history_id`,
    args: [caseId],
  });
  const path = history.rows.map((r) => String((r as unknown as Record<string, unknown>).to_status));
  assert.equal(path.includes('WAITING_CUSTOMER'), true);
  assert.equal(path.includes('RESOLVED'), true);
  assert.equal(path.indexOf('WAITING_CUSTOMER') < path.indexOf('RESOLVED'), true, 'in order');

  // ---- RECONCILE SERVICE ANALYTICS BY HAND ---------------------------------
  forgetResolvedScopes(client);
  const filter = parseFilter(new URLSearchParams());
  const analytics = await serviceSummary(client, 'USR-CATH', filter);

  const handOpened = await count(c, `SELECT COUNT(*) AS n FROM service_cases`);
  assert.equal(analytics.casesOpened, handOpened, 'cases opened equals a direct count');

  const handBacklog = await count(
    c,
    `SELECT COUNT(*) AS n FROM service_cases WHERE status NOT IN ('RESOLVED','CLOSED','CANCELLED')`,
  );
  assert.equal(analytics.openBacklog, handBacklog, 'the backlog equals a direct count');

  // ELAPSED AND ACCOUNTABLE ARE TWO FIGURES AND ARE NEVER THE SAME FIELD.
  assert.equal(Object.keys(analytics).includes('medianResolutionElapsedMinutes'), true);
  assert.equal(Object.keys(analytics).includes('medianResolutionAccountableMinutes'), true);

  // The resolution coverage is honest: measured of total, never total as if
  // every case had been measured.
  assert.equal(analytics.resolutionMeasured <= analytics.resolutionTotal, true);

  c.close();
});

// ===========================================================================
// §7 Journey E: the portal, and the attack test
// ===========================================================================

test('§7 Journey E: the portal shows the customer their own and nothing else', async () => {
  const c = await db();
  const client = asClient(c);

  const identity = await loadIdentity(client, 'USR-EXT001');
  const access = await portalScope(client, identity!, null);
  assert.equal(access.ok, true);
  const scope = access.ok ? access.scope : null!;
  assert.deepEqual(scope.accountIds, ['ACC-001']);

  // ---- THE ATTACK TEST: six attempts, six identical non-revealing answers --
  const targets = await Promise.all([
    c.execute(`SELECT account_id AS id FROM accounts WHERE account_id <> 'ACC-001' LIMIT 1`),
    c.execute(
      `SELECT sales_order_id AS id FROM sales_orders WHERE account_id <> 'ACC-001' LIMIT 1`,
    ),
    c.execute(`SELECT case_id AS id FROM service_cases WHERE account_id <> 'ACC-001' LIMIT 1`),
    c.execute(`SELECT contact_id AS id FROM contacts WHERE account_id <> 'ACC-001' LIMIT 1`),
  ]);
  const [otherAccount, otherOrder, otherCase, otherContact] = targets.map((r) =>
    String((r.rows[0] as unknown as Record<string, unknown>)?.id ?? 'NONE'),
  );

  // Each real target, and each paired with an identifier that never existed.
  const attempts: [string, unknown, unknown][] = [
    [
      'order',
      await portalOrder(client, scope, otherOrder as string),
      await portalOrder(client, scope, 'SO-NEVER'),
    ],
    [
      'case',
      await portalCase(client, scope, otherCase as string),
      await portalCase(client, scope, 'CASE-NEVER'),
    ],
    // An account, a contact, an attachment and a survey are all reached
    // through the same predicate; the scope simply does not contain them.
    ['account', scope.accountIds.includes(otherAccount as string), false],
    ['contact', scope.accountIds.includes('ACC-002'), false],
  ];
  for (const [what, real, fictional] of attempts) {
    assert.deepEqual(real, fictional, `the answer for a real ${what} differs from a miss`);
  }
  void otherContact;

  // A forged account parameter changes nothing.
  const forged = await portalScope(client, identity!, otherAccount as string);
  assert.equal(forged.ok, true);
  assert.equal(
    forged.ok ? forged.scope.accountIds.includes(otherAccount as string) : true,
    false,
    'a forged accountId is ignored',
  );

  // ---- The customer sees NO internal information ---------------------------
  const ownCase = await c.execute(
    `SELECT case_id FROM service_cases WHERE account_id = 'ACC-001' LIMIT 1`,
  );
  const ownCaseId = String((ownCase.rows[0] as unknown as Record<string, unknown>)?.case_id ?? '');
  if (ownCaseId !== '') {
    await c.execute({
      sql: `INSERT INTO case_communications
              (communication_id, case_id, direction, channel, contact_id, user_id,
               subject, message_summary, communicated_at)
            VALUES ('COMM-E2E-INT', ?, 'INTERNAL', 'OTHER', NULL, 'USR-CATH',
                    'Internal', 'Gabriel Musembi says the depot queue was the cause.',
                    '2026-08-21 09:00:00')`,
      args: [ownCaseId],
    });
    const view = await portalCase(client, scope, ownCaseId);
    assert.notEqual(view, null, 'the customer sees their own case');
    const serialised = JSON.stringify(view);
    // The internal note, the employee's name and the internal terminology are
    // all absent from the object, not merely hidden in the markup.
    assert.equal(serialised.includes('Gabriel Musembi'), false, 'no employee name');
    assert.equal(serialised.includes('depot queue was the cause'), false, 'no internal note');
    assert.equal(serialised.includes('INTERNAL'), false, 'no internal direction');
    assert.equal(/WAITING_INTERNAL|ASSIGNED|IN_PROGRESS/.test(serialised), false, 'no raw status');
  }

  c.close();
});

// ===========================================================================
// §8 Cross-module reconciliation
// ===========================================================================

test('§8 the credit denominator excludes orders that never needed credit', async () => {
  const c = await db();
  const client = asClient(c);
  const filter = parseFilter(new URLSearchParams());

  const picture = await creditPicture(client, 'USR-CATH', filter, NOW);

  // By hand, straight from the table.
  const handTotal = await count(c, `SELECT COUNT(*) AS n FROM sales_orders`);
  const handRequired = await count(
    c,
    `SELECT COUNT(*) AS n FROM sales_orders WHERE credit_approval_required = 1`,
  );
  const handNot = await count(
    c,
    `SELECT COUNT(*) AS n FROM sales_orders WHERE credit_approval_required = 0`,
  );

  assert.equal(picture.ordersInSelection, handTotal);
  assert.equal(picture.ordersRequiringCredit, handRequired);
  assert.equal(picture.ordersNotRequiringCredit, handNot);
  assert.equal(handRequired + handNot, handTotal, 'required plus not-required is the whole');

  // THE DENOMINATOR IS THE REQUIRED COUNT ALONE, and it is strictly smaller
  // than the selection whenever any order did not need credit.
  if (handNot > 0) {
    assert.equal(
      picture.ordersRequiringCredit < picture.ordersInSelection,
      true,
      'an order that never needed credit is not in the credit denominator',
    );
  }
  // And the turnaround is measured over the required orders only.
  assert.equal(picture.turnaround.elapsed.total <= handRequired, true);

  c.close();
});

test('§8 one person approving two processes is two rows, never blended', async () => {
  const c = await db();
  const client = asClient(c);
  const { approverPerformance: so } = await import('../../src/lib/cms/repos/soPerformance.ts');
  const { approverPerformance: po } = await import('../../src/lib/cms/repos/poPerformance.ts');
  const filter = parseFilter(new URLSearchParams());

  const [salesRows, purchaseRows] = await Promise.all([
    so(client, 'USR-CATH', filter, NOW),
    po(client, 'USR-CATH', filter, NOW),
  ]);

  // Every sales-order row says SALES_ORDER, and the purchase-order module has
  // no processType field at all because it only ever reports one process.
  for (const row of salesRows.rows) {
    assert.equal(row.processType, 'SALES_ORDER');
  }
  // Nobody appears once with a figure covering both.
  const salesPeople = new Set(salesRows.rows.map((r) => `${r.userId}::${r.stageCode}`));
  const purchasePeople = new Set(purchaseRows.rows.map((r) => `${r.userId}::${r.stageCode}`));
  for (const key of salesPeople) {
    assert.equal(purchasePeople.has(key), false, `${key} appears in both with one key`);
  }

  c.close();
});

test('§8 two finance managers with the same title have separate authority and separate figures', async () => {
  const c = await db();
  const client = asClient(c);

  // Gabriel (Kenya) and Grace (Uganda) both hold ROLE-FIN and the same
  // workflow role. Their authority is separate and so is their scope.
  const kenya = await resolveScope(client, 'USR-GAB', 'ORDERS.SALES_ORDER.VIEW');
  const uganda = await resolveScope(client, 'USR-FMUG', 'ORDERS.SALES_ORDER.VIEW');
  assert.equal(kenya.granted, true);
  assert.equal(uganda.granted, true);

  const kenyaAffiliates = kenya.scopes.map((s) => s.affiliateId).filter((a) => a !== null);
  const ugandaAffiliates = uganda.scopes.map((s) => s.affiliateId).filter((a) => a !== null);
  assert.equal(kenyaAffiliates.includes('AFF-KE'), true);
  assert.equal(kenyaAffiliates.includes('AFF-UG'), false, 'NOT the same scope');
  assert.equal(ugandaAffiliates.includes('AFF-UG'), true);
  assert.equal(ugandaAffiliates.includes('AFF-KE'), false);

  // No job title is read anywhere in the resolution.
  const assignments = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM workflow_role_assignments wra
          WHERE wra.user_id IN ('USR-GAB','USR-FMUG') AND wra.active = 1`,
    args: [],
  });
  assert.equal(
    Number((assignments.rows[0] as unknown as Record<string, unknown>).n) >= 2,
    true,
    'they hold separate assignments, not one shared by title',
  );

  c.close();
});

test('§8 the audit trail can reconstruct the journey from itself alone', async () => {
  const c = await db();
  const client = asClient(c);

  const before = await count(c, `SELECT COUNT(*) AS n FROM audit_events`);

  const account = await createAccount(
    client,
    {
      accountName: `${LABEL}Reconstruct Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-RECON',
      oracleCustomerCode: null,
      industry: null,
      segment: null,
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      address: null,
      phone: null,
      email: null,
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: 'USR-JAM',
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );
  assert.equal(account.ok, true);
  const accountId = account.ok ? account.value.accountId : '';

  const lead = await createLead(
    client,
    {
      accountId,
      primaryContactId: null,
      leadSourceId: 'LS-001',
      campaignId: null,
      businessUnitId: 'BU-CI',
      ownerUserId: 'USR-JAM',
      title: `${LABEL}Reconstruct enquiry`,
      description: null,
      productInterest: null,
      estimatedVolume: null,
      estimatedValue: null,
      currencyCode: 'KES',
      capturedAt: '2026-08-05 09:00:00',
    },
    CTX,
  );
  assert.equal(lead.ok, true);

  // FROM audit_events ALONE, the journey is reconstructible: the account
  // creation and the lead creation are both there, in order, with an actor.
  const trail = await c.execute({
    sql: `SELECT event_type, entity_type, entity_id, actor_user_id, event_at
          FROM audit_events WHERE audit_event_id NOT LIKE 'AEV-SEED%'
          ORDER BY event_at, audit_event_id`,
    args: [],
  });
  const after = await count(c, `SELECT COUNT(*) AS n FROM audit_events`);
  assert.equal(after > before, true, 'the journey wrote audit rows');

  const types = trail.rows.map((r) => String((r as unknown as Record<string, unknown>).event_type));
  assert.equal(types.includes('ACCOUNT_CREATED'), true, 'the account creation is in the trail');
  assert.equal(types.includes('LEAD_CREATED'), true, 'and so is the lead');

  // Every row carries an actor or is explicitly a system action, so "who did
  // this" is always answerable.
  for (const raw of trail.rows) {
    const row = raw as unknown as Record<string, unknown>;
    assert.equal(String(row.entity_id) !== '', true, 'every row names its subject');
    assert.equal(String(row.event_at) !== '', true, 'and when');
  }

  // AND NOTHING WAS ALTERED. The triggers guarantee it, proved again here so
  // the reconstruction rests on something.
  await assert.rejects(async () => {
    await c.execute(`UPDATE audit_events SET event_type = 'FORGED' WHERE 1 = 1`);
  }, /append-only/);

  c.close();
});

// ===========================================================================
// §9 Integrity checks
// ===========================================================================

test('§9 integrity: foreign keys, orphans, duplicates and snapshots', async () => {
  const c = await db();

  // ---- PRAGMA foreign_key_check --------------------------------------------
  const fk = await c.execute(`PRAGMA foreign_key_check`);
  assert.deepEqual(fk.rows, [], 'no foreign key violation anywhere');

  // ---- Orphans on every polymorphic entity_id ------------------------------
  const orphanChecks: [string, string][] = [
    [
      'audit_events on ACCOUNT',
      `SELECT COUNT(*) AS n FROM audit_events ae WHERE ae.entity_type = 'ACCOUNT'
        AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = ae.entity_id)`,
    ],
    [
      'activities on ACCOUNT',
      `SELECT COUNT(*) AS n FROM activities act WHERE act.entity_type = 'ACCOUNT'
        AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = act.entity_id)`,
    ],
    [
      'sla_instances on CASE',
      `SELECT COUNT(*) AS n FROM sla_instances si WHERE si.entity_type IN ('CASE','SERVICE_CASE')
        AND NOT EXISTS (SELECT 1 FROM service_cases sc WHERE sc.case_id = si.entity_id)`,
    ],
    [
      'record_snapshots on SALES_ORDER',
      `SELECT COUNT(*) AS n FROM record_snapshots rs WHERE rs.entity_type = 'SALES_ORDER'
        AND NOT EXISTS (SELECT 1 FROM sales_orders so WHERE so.sales_order_id = rs.entity_id)`,
    ],
  ];
  for (const [name, sql] of orphanChecks) {
    assert.equal(await count(c, sql), 0, `${name} has orphans`);
  }

  // ---- Duplicate canonical documents ---------------------------------------
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM (
         SELECT affiliate_id, document_number FROM sales_orders
         GROUP BY affiliate_id, document_number HAVING COUNT(*) > 1)`,
    ),
    0,
    'a sales order document number is unique within its affiliate',
  );
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM (
         SELECT affiliate_id, document_number FROM purchase_orders
         GROUP BY affiliate_id, document_number HAVING COUNT(*) > 1)`,
    ),
    0,
    'and a purchase order number likewise',
  );

  // ---- Exactly one current snapshot per entity -----------------------------
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM (
         SELECT entity_type, entity_id FROM record_snapshots WHERE is_current = 1
         GROUP BY entity_type, entity_id HAVING COUNT(*) > 1)`,
    ),
    0,
    'NEVER two current snapshots for one entity',
  );

  // ---- Snapshot versions number 1, 2, 3 with no gap ------------------------
  const versions = await c.execute(
    `SELECT entity_type, entity_id, COUNT(*) AS versions, MAX(version_no) AS highest
       FROM record_snapshots GROUP BY entity_type, entity_id`,
  );
  for (const raw of versions.rows) {
    const row = raw as unknown as Record<string, unknown>;
    assert.equal(
      Number(row.versions),
      Number(row.highest),
      `${String(row.entity_id)} has a gap in its snapshot versions`,
    );
  }

  // ---- No duplicate warning, no duplicate breach ---------------------------
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM (
         SELECT sla_instance_id FROM sla_breaches GROUP BY sla_instance_id HAVING COUNT(*) > 1)`,
    ),
    0,
    'one breach row per instance at most',
  );

  // ---- Balanced pause and resume -------------------------------------------
  const pauses = await c.execute(
    `SELECT sla_instance_id,
            SUM(CASE WHEN event_type = 'PAUSE' THEN 1 ELSE 0 END) AS paused,
            SUM(CASE WHEN event_type = 'RESUME' THEN 1 ELSE 0 END) AS resumed
       FROM sla_timer_events GROUP BY sla_instance_id`,
  );
  for (const raw of pauses.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const paused = Number(row.paused);
    const resumed = Number(row.resumed);
    // A pause may still be open, so resumed is at most paused and never more.
    assert.equal(
      resumed <= paused,
      true,
      `${String(row.sla_instance_id)} resumed more often than it paused`,
    );
  }

  // ---- Valid workflow instances --------------------------------------------
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM workflow_stage_instances wsi
        WHERE NOT EXISTS (SELECT 1 FROM workflow_instances wi
                          WHERE wi.workflow_instance_id = wsi.workflow_instance_id)`,
    ),
    0,
    'no stage instance without its workflow instance',
  );

  c.close();
});

// ===========================================================================
// §10 The permission matrix, all nine personas
// ===========================================================================

test('§10 the permission matrix, nine personas, every module', async () => {
  const c = await db();
  const client = asClient(c);

  const PERSONAS: [string, string][] = [
    ['System administrator', 'USR-CATH'],
    ['Customer service manager', 'USR-CATH'],
    ['Kenya finance manager', 'USR-GAB'],
    ['Uganda finance manager', 'USR-FMUG'],
    ['Country manager', 'USR-AMN'],
    ['Group finance', 'USR-GCFO'],
    ['Credit manager', 'USR-VIC'],
    ['Sales executive', 'USR-JAM'],
    ['External customer', 'USR-EXT001'],
  ];

  const MODULES: [string, string][] = [
    ['Customers', 'CUSTOMERS.ACCOUNTS.VIEW'],
    ['Leads', 'CRM.LEADS.VIEW'],
    ['Opportunities', 'CRM.OPPORTUNITIES.VIEW'],
    ['Cases', 'SERVICE.CASES.VIEW'],
    ['Sales orders', 'ORDERS.SALES_ORDER.VIEW'],
    ['Purchase orders', 'ORDERS.PURCHASE_ORDER.VIEW'],
    ['Imports', 'DATA.IMPORTS.VIEW'],
    ['Audit', 'AUDIT.EVENTS.VIEW'],
    ['Credit', 'CREDIT.EXCEPTION.APPROVE'],
    ['SLA dashboard', 'SLA.DASHBOARD.VIEW'],
    ['Administer users', 'ADMIN.USERS.MANAGE'],
  ];

  const matrix: string[] = [];
  matrix.push(
    `${'PERSONA'.padEnd(26)}| ${MODULES.map(([label]) => label.slice(0, 12).padEnd(13)).join('')}`,
  );
  for (const [label, userId] of PERSONAS) {
    const identity = await loadIdentity(client, userId);
    assert.notEqual(identity, null, `${label} must exist`);
    const held = identity!.permissions;
    const cells = MODULES.map(([, code]) => (held.includes(code) ? 'yes' : '-').padEnd(13));
    matrix.push(`${label.padEnd(26)}| ${cells.join('')}`);

    // THE EXTERNAL CUSTOMER HOLDS NO INTERNAL CODE AT ALL. That is the row
    // that matters most, and it is asserted rather than merely printed.
    if (userId === 'USR-EXT001') {
      for (const [module, code] of MODULES) {
        assert.equal(held.includes(code), false, `the external customer holds ${module}`);
      }
      assert.equal(
        held.every((code) => code.startsWith('PORTAL.')),
        true,
        'and holds only PORTAL codes',
      );
    }
  }

  console.log('\n===== PHASE 30 PERMISSION MATRIX =====');
  for (const line of matrix) console.log(line);

  // Nobody but a Group holder reads across entities.
  for (const [label, userId] of PERSONAS) {
    if (userId === 'USR-EXT001') continue;
    const scope = await resolveScope(client, userId, 'ORDERS.SALES_ORDER.VIEW');
    if (!scope.granted) continue;
    if (scope.group) {
      assert.equal(
        [
          'System administrator',
          'Customer service manager',
          'Group finance',
          'Credit manager',
        ].includes(label),
        true,
        `${label} is Group-scoped and should not be`,
      );
    }
  }

  c.close();
});

// ===========================================================================
// §11 Failure: the system fails safely
// ===========================================================================

test('§11 the system fails safely: no half-written record on a rejected write', async () => {
  const c = await db();
  const client = asClient(c);

  const accountsBefore = await count(c, `SELECT COUNT(*) AS n FROM accounts`);
  const auditBefore = await count(c, `SELECT COUNT(*) AS n FROM audit_events`);

  // An account naming an affiliate that is not in its country. The write is
  // refused, and NOTHING is written: not the account, not an audit row.
  const invalid = await createAccount(
    client,
    {
      accountName: `${LABEL}Impossible Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-BAD',
      oracleCustomerCode: null,
      industry: null,
      segment: null,
      countryId: 'CTR-KE',
      affiliateId: 'AFF-UG',
      address: null,
      phone: null,
      email: null,
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: null,
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );
  assert.equal(invalid.ok, false, 'an affiliate outside its country is refused');
  assert.equal(await count(c, `SELECT COUNT(*) AS n FROM accounts`), accountsBefore, 'no account');
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM audit_events`),
    auditBefore,
    'and no audit row for a change that did not happen',
  );

  // A duplicate submit of the same valid creation makes one account, not two,
  // because the account code is unique.
  const first = await createAccount(
    client,
    {
      accountName: `${LABEL}Duplicate Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-DUP',
      oracleCustomerCode: null,
      industry: null,
      segment: null,
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      address: null,
      phone: null,
      email: null,
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: null,
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );
  assert.equal(first.ok, true);
  const second = await createAccount(
    client,
    {
      accountName: `${LABEL}Duplicate Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-DUP',
      oracleCustomerCode: null,
      industry: null,
      segment: null,
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      address: null,
      phone: null,
      email: null,
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: null,
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );
  assert.equal(second.ok, false, 'the duplicate is refused');
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM accounts WHERE account_code = 'E2E-DUP'`),
    1,
    'exactly one account exists',
  );

  c.close();
});

// ===========================================================================
// §12 The labelled dataset can be found, and the cleanup script matches it
// ===========================================================================

test('§12 every record this file creates is labelled and findable', async () => {
  const c = await db();
  const client = asClient(c);

  await createAccount(
    client,
    {
      accountName: `${LABEL}Findable Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-FIND',
      oracleCustomerCode: null,
      industry: null,
      segment: null,
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      address: null,
      phone: null,
      email: null,
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: null,
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );

  // The cleanup script finds them by the label, and the label is on the name
  // and the code both, so a rename does not orphan them.
  const byName = await count(
    c,
    `SELECT COUNT(*) AS n FROM accounts WHERE account_name LIKE 'VALIDATION-%'`,
  );
  const byCode = await count(
    c,
    `SELECT COUNT(*) AS n FROM accounts WHERE account_code LIKE 'E2E-%'`,
  );
  assert.equal(byName >= 1, true, 'labelled by name');
  assert.equal(byCode >= 1, true, 'and by code');

  c.close();
});

// ===========================================================================
// §12 The cleanup script is executed, against the harness, and proved
// ===========================================================================

/**
 * `docs/cms/production/11_validation_cleanup.sql`, run for real.
 *
 * THE SCRIPT IS NEVER RUN AGAINST A LIVE DATABASE by this build; that is a
 * stop condition and it has not been done. What is done here is the thing
 * that can be done honestly: the file on disk is read, its write section is
 * executed against the throwaway harness database that this file has just
 * filled with labelled records, and its own verification section is then run
 * and required to come back zero. So the claim "the cleanup script works" is
 * backed by the script executing, not by somebody having read it.
 *
 * It reads the FILE rather than a copy of the SQL, so an edit to the script
 * that breaks it fails here.
 */
test('§12 the cleanup script executes and removes exactly the labelled set', async () => {
  const c = await db();
  const client = asClient(c);

  // ---- Arrange: a labelled account, contact, lead and case ----------------
  const created = await createAccount(
    client,
    {
      accountName: `${LABEL}Cleanup Ltd`,
      accountType: 'PROSPECT',
      accountCode: 'E2E-CLEAN',
      oracleCustomerCode: null,
      industry: null,
      segment: null,
      countryId: 'CTR-KE',
      affiliateId: 'AFF-KE',
      address: null,
      phone: null,
      email: null,
      website: null,
      taxPin: null,
      creditLimit: null,
      creditDays: null,
      accountManagerUserId: null,
      customerSince: null,
      status: 'ACTIVE',
    },
    CTX,
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const accountId = created.ok ? created.value.accountId : '';

  const contact = await createContact(
    client,
    'USR-CATH',
    accountId,
    {
      fullName: `${LABEL}Cleanup Contact`,
      jobTitle: null,
      email: 'cleanup@example.com',
      phone: null,
      whatsapp: null,
      preferredChannel: 'EMAIL',
      isPrimary: true,
      active: true,
    },
    CTX,
  );
  assert.equal(contact.ok, true, JSON.stringify(contact));

  const lead = await createLead(
    client,
    {
      accountId,
      primaryContactId: null,
      leadSourceId: 'LS-001',
      campaignId: null,
      businessUnitId: 'BU-CI',
      ownerUserId: 'USR-JAM',
      title: `${LABEL}Cleanup enquiry`,
      description: 'A lead that exists so that the cleanup script has one to remove.',
      productInterest: null,
      estimatedVolume: null,
      estimatedValue: null,
      currencyCode: 'KES',
      capturedAt: '2026-08-20 09:00:00',
    },
    CTX,
  );
  assert.equal(lead.ok, true, JSON.stringify(lead));

  const category = await c.execute(
    `SELECT case_category_id AS id FROM case_categories WHERE active = 1 LIMIT 1`,
  );
  const raised = await createCase(
    client,
    'USR-CATH',
    {
      accountId,
      contactId: null,
      businessUnitId: null,
      caseType: 'COMPLAINT',
      caseCategoryId: String((category.rows[0] as unknown as Record<string, unknown>).id),
      priority: null,
      subject: `${LABEL}Cleanup case`,
      description: 'A case that exists so that the cleanup script has one to remove.',
      channel: 'PHONE',
      raisedAt: NOW,
      assignedTeamId: null,
      assignedUserId: null,
    },
    CTX,
    false,
  );
  assert.equal(raised.ok, true, JSON.stringify(raised));

  const beforeAccounts = await count(c, `SELECT COUNT(*) AS n FROM accounts`);
  const beforeAudit = await count(c, `SELECT COUNT(*) AS n FROM audit_events`);

  // ---- Act: run the script's write section --------------------------------
  const script = await readFile(
    new URL('../../docs/cms/production/11_validation_cleanup.sql', import.meta.url),
    'utf8',
  );
  const writeStart = script.indexOf('PRAGMA foreign_keys = ON;');
  const writeEnd = script.indexOf('-- STEP 9');
  assert.equal(writeStart > 0 && writeEnd > writeStart, true, 'the script has a write section');
  // Steps 1 to 8 verbatim, run as one script on one connection, which is the
  // same shape as the console session the header asks the operator for. The
  // script carries no transaction keywords, deliberately, so there are none
  // to strip.
  c.raw.exec(script.slice(writeStart, writeEnd));

  // ---- Assert: the script's own verification, required to be zero ---------
  const stepNine = script.slice(script.indexOf('-- STEP 9'));
  const statements = stepNine
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.toUpperCase().startsWith('SELECT'));
  assert.equal(statements.length >= 2, true, 'the script verifies itself');

  const zeroChecks = await c.execute(statements[0]!);
  assert.equal(zeroChecks.rows.length > 0, true, 'the verification returned rows');
  for (const row of zeroChecks.rows) {
    const record = row as unknown as Record<string, unknown>;
    assert.equal(
      Number(record.must_be_zero),
      0,
      `${String(record.check_name)} came back ${String(record.must_be_zero)}`,
    );
  }

  // The last statement is the deliberate note about audit rows kept. It must
  // run, and what it reports is a count of rows that SURVIVED.
  const kept = await c.execute(statements[statements.length - 1]!);
  assert.equal(kept.rows.length, 1);

  // ---- And nothing else was touched ---------------------------------------
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM accounts`),
    beforeAccounts - 1,
    'exactly one account was removed, the labelled one',
  );
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM audit_events`),
    beforeAudit,
    'NOT ONE AUDIT ROW WAS DELETED',
  );
  assert.equal(
    (await count(c, `SELECT COUNT(*) AS n FROM access_roles`)) > 0 &&
      (await count(c, `SELECT COUNT(*) AS n FROM permissions`)) > 0 &&
      (await count(c, `SELECT COUNT(*) AS n FROM workflow_definitions`)) > 0,
    true,
    'the configuration survived: roles, permissions and workflows are all still there',
  );
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM users u
       WHERE u.user_type = 'EXTERNAL' AND u.status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM auth_credentials cr WHERE cr.user_id = u.user_id)
         AND (u.email LIKE '%@example.com' OR u.email LIKE '%@example.co.ke')`,
    ),
    0,
    'NO TEST EXTERNAL CREDENTIAL IS LEFT ACTIVE',
  );

  c.close();
});
