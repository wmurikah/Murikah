/**
 * Build Prompt 40, section 3: why SO Credit Approver has no eligible approver
 * for the Credit Exception Workflow, at two stages.
 *
 * THE FINDING IS DERIVABLE FROM THE CHECK'S OWN PREDICATE, and it is worth
 * stating because the reported symptom sends you looking in the wrong place.
 * "The credit officers were assigned to a workflow role" is true, and the check
 * still reports no eligible approver, so the natural conclusion is that the
 * stages point at a DIFFERENT role from the one they hold. They do not. Both
 * stages point at the same role the officers hold.
 *
 * What fails is the SCOPE test. `workflowRolesWithoutApprover` requires the
 * holder's assignment to reach the workflow's own scope:
 *
 *     AND (wra.scope_type = 'GROUP'
 *          OR (wd.country_id       IS NOT NULL AND wra.country_id       = wd.country_id)
 *          OR (wd.affiliate_id     IS NOT NULL AND wra.affiliate_id     = wd.affiliate_id)
 *          OR (wd.business_unit_id IS NOT NULL AND wra.business_unit_id = wd.business_unit_id))
 *
 * The Credit Exception Workflow is configured with NO country, NO affiliate and
 * NO business unit — it is a Group-wide process, which is correct for credit.
 * Every scoped branch is therefore false by construction, and the ONLY
 * assignment that can staff it is one with `scope_type = 'GROUP'`.
 *
 * So a credit officer assigned the natural way — "Victor covers Kenya", an
 * AFFILIATE or COUNTRY scope — holds exactly the right role and still staffs
 * nothing. That is not a bug in the check. It is the check doing its job: an
 * affiliate-scoped approver genuinely cannot approve a Group-wide exception,
 * and counting them would be the false reassurance the check exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import { systemHealth } from '../../src/lib/cms/repos/controlCentre.ts';

const client = (c: TestClient) => c as never;
const NOW = new Date('2026-08-30T09:00:00Z');

const approverCheck = async (db: TestClient) => {
  const health = await systemHealth(client(db), NOW);
  const found = health.checks.find((check) => check.key === 'workflow_roles_without_approver');
  assert.ok(found, 'the approver check did not run');
  return found;
};

test('both Credit Exception stages require the same role, not two different ones', async () => {
  const db = createTestDb();
  await seedHass(db);
  const stages = await db.execute(`
    SELECT ws.stage_code, ws.sequence_no, wr.role_code, wr.role_name
      FROM workflow_stages ws
      JOIN workflow_definitions wd ON wd.workflow_definition_id = ws.workflow_definition_id
      JOIN workflow_roles wr ON wr.workflow_role_id = ws.assigned_workflow_role_id
     WHERE wd.process_type = 'CREDIT_EXCEPTION'
     ORDER BY ws.sequence_no`);
  assert.equal(stages.rows.length, 2, 'the Credit Exception Workflow has two stages');
  const codes = stages.rows.map((row) => String(row.role_code));
  assert.deepEqual(codes, ['SO_CREDIT_APPROVER', 'SO_CREDIT_APPROVER']);
  console.log(
    `[credit] both stages require ${codes[0]}: ` +
      stages.rows.map((r) => `${r.stage_code} (${r.sequence_no})`).join(', '),
  );
  db.close();
});

test('the Credit Exception Workflow is Group-wide, so only a GROUP holder staffs it', async () => {
  const db = createTestDb();
  await seedHass(db);
  const workflow = await db.execute(`
    SELECT country_id, affiliate_id, business_unit_id FROM workflow_definitions
     WHERE process_type = 'CREDIT_EXCEPTION'`);
  const row = workflow.rows[0]!;
  // Every scoped branch of the check tests `wd.<column> IS NOT NULL` first, so
  // all three being null leaves GROUP as the only way through.
  assert.equal(row.country_id, null);
  assert.equal(row.affiliate_id, null);
  assert.equal(row.business_unit_id, null);
  console.log('[credit] the workflow has no country, affiliate or business unit');

  // The seed holds a GROUP-scoped credit approver, so the check is clean here.
  const clean = await approverCheck(db);
  assert.equal(clean.count, 0, 'the seed should have an eligible approver');

  // NARROW THAT ONE ASSIGNMENT TO AN AFFILIATE — the natural way to describe a
  // credit officer, and what the live configuration evidently does — and the
  // same role, held by the same person, staffs nothing.
  await db.execute(`
    UPDATE workflow_role_assignments
       SET scope_type = 'AFFILIATE', affiliate_id = 'AFF-KE'
     WHERE workflow_role_id = 'WROLE-SO-CRD'`);
  const broken = await approverCheck(db);
  assert.equal(broken.count, 2, 'both Credit Exception stages should now report no approver');
  for (const example of broken.examples) {
    assert.match(String(example.detail), /Credit Exception Workflow/);
  }
  console.log(
    '[credit] with the holder scoped to an affiliate, both stages report no eligible approver',
  );
  db.close();
});

test('a GROUP-scoped assignment is what clears it', async () => {
  const db = createTestDb();
  await seedHass(db);
  await db.execute(`
    UPDATE workflow_role_assignments
       SET scope_type = 'AFFILIATE', affiliate_id = 'AFF-KE'
     WHERE workflow_role_id = 'WROLE-SO-CRD'`);
  assert.equal((await approverCheck(db)).count, 2);

  // EITHER of the two corrections works. This is the one that keeps credit a
  // Group-wide process, which is what the workflow's own configuration says it
  // is; the other is to give the workflow a country or an affiliate so scoped
  // holders match, which changes what the process means.
  await db.execute(`
    UPDATE workflow_role_assignments
       SET scope_type = 'GROUP', affiliate_id = NULL
     WHERE workflow_role_id = 'WROLE-SO-CRD'`);
  assert.equal((await approverCheck(db)).count, 0, 'a Group holder staffs a Group-wide workflow');
  db.close();
});
