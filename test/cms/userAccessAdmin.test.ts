/**
 * User administration: job title, access roles, permission preview, workflow
 * authority, and the job title mapping catalogue.
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING. The Edit tab now administers a
 * person's access from the same screen that edits their name, which is a
 * convenience with three ways to become a security defect:
 *
 *   1. a title change quietly granting the roles the title maps to;
 *   2. a role arriving with no data scope, or with a wider one than anybody
 *      chose;
 *   3. an administrator escalating themselves on their own record.
 *
 * So each of the three is asserted as a REFUSAL against the repository and the
 * validator, not against the markup — the markup is what a screen offers, and
 * a screen is not a control.
 *
 * Everything runs against the operator's own seed, so "Catherine Mwangi is the
 * only administrator" is a statement about the configuration this product will
 * run against rather than about a fixture invented here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FieldError } from '../../src/lib/validation.ts';
import { readFileSync } from 'node:fs';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  changePrimaryJobTitle,
  listAssignments,
  listJobTitles,
  listUserRoles,
  listWorkflowAuthority,
} from '../../src/lib/cms/repos/userAdmin.ts';
import {
  assignUserRole,
  effectivePermissions,
  rolePermissionMap,
  updateUserRole,
  type WriteResult,
} from '../../src/lib/cms/repos/rbacAdmin.ts';
import {
  createMapping,
  deleteMapping,
  listMappings,
  mappedRoleIds,
  mappingsForTitle,
  updateMapping,
} from '../../src/lib/cms/repos/jobTitleMappings.ts';
import {
  validateApplyDefaults,
  validateMapping,
} from '../../src/lib/cms/admin/jobTitleMappingInput.ts';
import { createAssignment as createWorkflowAssignment } from '../../src/lib/cms/repos/workflowAdmin.ts';

const NOW = new Date('2026-08-27T09:00:00Z');
const TODAY = '2026-08-27';
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listJobTitles>[0];

/**
 * A refusal, narrowed to one that names the fields it refused on.
 *
 * `not_found` carries no fields, so the union does not expose them and every
 * assertion below would have to cast. Asserting the shape here once means the
 * tests read what they mean: a refusal that says nothing about which control
 * was wrong is itself a defect.
 */
function refused<T>(result: WriteResult<T>): {
  kind: 'conflict' | 'invalid_reference';
  fields: FieldError[];
} {
  assert.equal(result.ok, false, 'the write was expected to be refused');
  const refusal = result as Extract<WriteResult<T>, { ok: false }>;
  assert.notEqual(refusal.kind, 'not_found', 'the refusal named no field');
  return refusal as { kind: 'conflict' | 'invalid_reference'; fields: FieldError[] };
}
function accepted<T>(result: WriteResult<T>): T {
  assert.ok(result.ok, `the write was refused: ${JSON.stringify(result)}`);
  return result.value;
}

// ---- job title -------------------------------------------------------------

test('the job title dropdown is fed by the job_titles table and offers only live titles', async () => {
  const c = await db();
  const titles = await listJobTitles(asClient(c));
  assert.ok(titles.length > 0, 'the seed carries job titles');
  assert.ok(
    titles.every((t) => t.jobTitleId !== '' && t.titleName !== ''),
    'every option has an id to store and a name to show',
  );
  // The panel offers active titles, plus whichever one is currently in force
  // even if it has been deactivated — hiding that would render the control as
  // if the person had no title at all.
  const panel = readFileSync('src/components/cms/CmsUserAccessPanel.astro', 'utf8');
  assert.match(
    panel,
    /\.filter\(\(t\) => t\.active \|\| t\.jobTitleId === primary\?\.jobTitleId\)/,
  );
  assert.match(panel, /label: 'Select job title'/, 'no current title says so');
  // A title is chosen, never typed. No text input reaches job_title_id.
  assert.ok(!/name="jobTitleId"[^>]*type="text"/.test(panel));
  c.close();
});

test('changing a title supersedes the current assignment and corrupts no history', async () => {
  const c = await db();
  const before = await listAssignments(asClient(c), SEED.gabriel);
  const original = before.find((a) => a.current && a.isPrimary);
  assert.ok(original, 'the seeded person has a current primary assignment');

  const created = accepted(
    await changePrimaryJobTitle(asClient(c), SEED.gabriel, SEED.titleCountryManager, CTX),
  );
  assert.equal(created.jobTitleId, SEED.titleCountryManager);
  assert.equal(created.isPrimary, true);
  assert.equal(created.current, true);
  // The new row inherits the placement. A title change is not a posting.
  assert.equal(created.departmentId, original.departmentId);
  assert.equal(created.level, original.level);
  assert.equal(created.affiliateId, original.affiliateId);
  assert.equal(created.countryId, original.countryId);

  // THE OLD ROW IS STILL THERE, STILL SAYING WHAT IT SAID. Ended, not
  // rewritten: its job title, its start date and its placement are untouched,
  // which is what makes "who was the Finance Manager in July" answerable.
  const after = await listAssignments(asClient(c), SEED.gabriel);
  const superseded = after.find((a) => a.assignmentId === original.assignmentId);
  assert.ok(superseded, 'the previous assignment row still exists');
  assert.equal(superseded.jobTitleId, original.jobTitleId, 'its title was not rewritten');
  assert.equal(superseded.effectiveFrom, original.effectiveFrom, 'its start was not rewritten');
  assert.equal(superseded.effectiveTo, TODAY, 'it was ended today');
  assert.equal(superseded.current, false);
  // And exactly one primary is in force, which the header depends on.
  assert.equal(after.filter((a) => a.current && a.isPrimary).length, 1);

  const events = query(
    c,
    `SELECT event_type, entity_type, entity_id, before_json, after_json FROM audit_events
      WHERE event_type = 'JOB_TITLE_CHANGED'`,
  );
  assert.equal(events.length, 1, 'the change is audited once, on the user');
  assert.equal(events[0]?.entity_id, SEED.gabriel);
  assert.match(String(events[0]?.before_json), new RegExp(original.jobTitleId));
  assert.match(String(events[0]?.after_json), new RegExp(SEED.titleCountryManager));
  c.close();
});

test('a title change grants no role and no authority', async () => {
  const c = await db();
  // Map the destination title to a role, so there IS something a careless
  // implementation could have applied.
  accepted(
    await createMapping(
      asClient(c),
      'ACCESS',
      { jobTitleId: SEED.titleCountryManager, targetId: SEED.roleAdmin, active: true },
      CTX,
    ),
  );
  const rolesBefore = await listUserRoles(asClient(c), SEED.gabriel);
  const authorityBefore = await listWorkflowAuthority(asClient(c), SEED.gabriel);

  accepted(await changePrimaryJobTitle(asClient(c), SEED.gabriel, SEED.titleCountryManager, CTX));

  const rolesAfter = await listUserRoles(asClient(c), SEED.gabriel);
  const authorityAfter = await listWorkflowAuthority(asClient(c), SEED.gabriel);
  assert.deepEqual(
    rolesAfter.map((r) => r.roleId).sort(),
    rolesBefore.map((r) => r.roleId).sort(),
    'the title change granted a role',
  );
  assert.equal(authorityAfter.length, authorityBefore.length);
  assert.equal(
    rolesAfter.some((r) => r.roleId === SEED.roleAdmin),
    false,
    'the mapped role was applied without anybody confirming it',
  );
  c.close();
});

test('a title cannot be set on somebody with no assignment, and says which tab can', async () => {
  const c = await db();
  const external = SEED.external[0] ?? '';
  const result = refused(
    await changePrimaryJobTitle(asClient(c), external, SEED.titleFinanceManager, CTX),
  );
  assert.match(String(result.fields[0]?.message), /no current assignment/i);
  assert.match(String(result.fields[0]?.message), /Assignments tab/);
  // Nothing was written on the way to the refusal.
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM user_assignments WHERE user_id = ?`, external)[0]?.n,
    0,
  );
  c.close();
});

test('a deactivated or unknown title is refused', async () => {
  const c = await db();
  await c.execute({
    sql: `UPDATE job_titles SET active = 0 WHERE job_title_id = ?`,
    args: [SEED.titleCountryManager],
  });
  assert.match(
    String(
      refused(await changePrimaryJobTitle(asClient(c), SEED.gabriel, SEED.titleCountryManager, CTX))
        .fields[0]?.message,
    ),
    /deactivated/i,
  );
  assert.match(
    String(
      refused(await changePrimaryJobTitle(asClient(c), SEED.gabriel, 'JT-NOPE', CTX)).fields[0]
        ?.message,
    ),
    /does not exist/i,
  );
  c.close();
});

// ---- access roles and the permission preview -------------------------------

test('a person may hold several access roles, each keeping its own scope', async () => {
  const c = await db();
  accepted(
    await assignUserRole(
      asClient(c),
      SEED.gabriel,
      {
        // A SECOND role, not the one he already holds: the point is that a
        // person carries several, each with its own scope.
        roleId: 'ROLE-CRD',
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
        active: true,
        scopes: [
          {
            scopeType: 'AFFILIATE',
            countryId: null,
            affiliateId: SEED.affUganda,
            businessUnitId: null,
            teamId: null,
          },
        ],
      },
      CTX,
    ),
  );
  const roles = (await listUserRoles(asClient(c), SEED.gabriel)).filter((r) => r.active);
  assert.ok(roles.length >= 2, 'more than one role is held');
  // EVERY ONE CARRIES ITS OWN SCOPE, and granting the second did not disturb
  // the first. A screen that dropped a scope would be handing somebody a role
  // that reaches nothing, or everything.
  for (const role of roles) {
    assert.ok(role.scopes.length > 0, `${role.roleName} lost its scope`);
  }
  const added = roles.find((r) => r.roleId === 'ROLE-CRD');
  assert.equal(added?.scopes[0]?.scopeType, 'AFFILIATE');
  assert.equal(added?.scopes[0]?.target, 'Hass Petroleum Uganda');
  c.close();
});

test('the effective permission preview is the union of the selected roles, and nothing else', async () => {
  const c = await db();
  const map = await rolePermissionMap(asClient(c));

  const none = effectivePermissions(map, []);
  assert.equal(none.length, 0, 'no role grants nothing');

  const admin = effectivePermissions(map, [SEED.roleAdmin]);
  assert.ok(admin.length > 0);
  const codes = new Set(admin.flatMap((g) => g.entries.map((e) => e.code)));
  // Read in words, with the raw code kept for the disclosure beside it.
  assert.ok(
    admin.every((group) => group.entries.every((entry) => /^[A-Z][a-z]/.test(entry.label))),
    'the preview shows readable labels rather than raw codes',
  );
  assert.ok(codes.has('ADMIN.ROLES.MANAGE'), 'the administrator role carries the role code');

  // ADDING A ROLE ADDS ONLY WHAT THAT ROLE CARRIES.
  const both = effectivePermissions(map, [SEED.roleAdmin, SEED.roleFinance]);
  const bothCodes = new Set(both.flatMap((g) => g.entries.map((e) => e.code)));
  for (const code of codes) assert.ok(bothCodes.has(code), `${code} was lost by adding a role`);
  const financeOnly = new Set(
    effectivePermissions(map, [SEED.roleFinance]).flatMap((g) => g.entries.map((e) => e.code)),
  );
  for (const code of bothCodes) {
    assert.ok(codes.has(code) || financeOnly.has(code), `${code} came from neither role`);
  }
  c.close();
});

test('removing a role removes its permissions unless another role still grants them', async () => {
  const c = await db();
  const map = await rolePermissionMap(asClient(c));
  const codesOf = (roleIds: string[]) =>
    new Set(effectivePermissions(map, roleIds).flatMap((g) => g.entries.map((e) => e.code)));

  // Two ordinary roles, not the administrator one: ROLE-ADMIN is granted
  // everything by the seed, so nothing would ever be lost by dropping a role
  // beside it and the assertion would prove nothing.
  const finance = codesOf([SEED.roleFinance]);
  const credit = codesOf(['ROLE-CRD']);
  const both = codesOf([SEED.roleFinance, 'ROLE-CRD']);
  const shared = [...finance].filter((code) => credit.has(code));
  const financeAlone = [...finance].filter((code) => !credit.has(code));
  assert.ok(financeAlone.length > 0, 'the fixture needs a code only finance carries');
  assert.ok(shared.length > 0, 'the fixture needs a code both carry');

  // Drop finance. What only finance granted is gone; what credit also grants
  // survives, which is the whole point of resolving a union rather than
  // subtracting one role's list.
  for (const code of financeAlone) {
    assert.equal(credit.has(code), false, `${code} survived losing the only role granting it`);
    assert.ok(both.has(code), 'the union lost a code one of its roles grants');
  }
  for (const code of shared) {
    assert.ok(credit.has(code), `${code} was lost though another role still grants it`);
  }
  c.close();
});

test('a deactivated role contributes nothing to the preview', async () => {
  const c = await db();
  await c.execute({
    sql: `UPDATE access_roles SET active = 0 WHERE role_id = ?`,
    args: [SEED.roleFinance],
  });
  const map = await rolePermissionMap(asClient(c));
  assert.equal(
    effectivePermissions(map, [SEED.roleFinance]).length,
    0,
    'an inactive role still previewed as granting something',
  );
  c.close();
});

// ---- self-escalation -------------------------------------------------------

test('an administrator cannot grant themselves a role, whatever the screen offers', async () => {
  const c = await db();
  const result = refused(
    await assignUserRole(
      asClient(c),
      // The subject is the actor. This is the request a rewritten browser makes.
      CTX.actorUserId,
      {
        roleId: SEED.roleFinance,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        active: true,
        scopes: [
          {
            scopeType: 'GROUP',
            countryId: null,
            affiliateId: null,
            businessUnitId: null,
            teamId: null,
          },
        ],
      },
      CTX,
    ),
  );
  assert.match(String(result.fields[0]?.message), /your own access/i);
  assert.equal(
    query(
      c,
      `SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role_id = ?`,
      CTX.actorUserId,
      SEED.roleFinance,
    )[0]?.n,
    0,
    'the refusal wrote a row anyway',
  );
  c.close();
});

test('an administrator cannot widen their own scope, but may give a role up', async () => {
  const c = await db();
  const held = query(
    c,
    `SELECT user_role_id FROM user_roles WHERE user_id = ? LIMIT 1`,
    CTX.actorUserId,
  );
  const userRoleId = String(held[0]?.user_role_id ?? '');
  assert.ok(userRoleId !== '');

  // Replacing your own scopes is an escalation route even though no role is
  // assigned: TEAM becomes GROUP and the caller reaches everything.
  const widened = refused(
    await updateUserRole(
      asClient(c),
      userRoleId,
      {
        effectiveTo: null,
        active: true,
        scopes: [
          {
            scopeType: 'GROUP',
            countryId: null,
            affiliateId: null,
            businessUnitId: null,
            teamId: null,
          },
        ],
      },
      CTX,
    ),
  );
  assert.match(String(widened.fields[0]?.message), /your own access/i);

  // Giving it up takes access away, so it is allowed — and is then decided by
  // the last-administrator guard, which is a different question.
  // The refusal that comes back is the LOCKOUT, not the self rule: giving up
  // your own role got past the self guard, and this seed has exactly one
  // administrator, so the other guard caught it. Two different rules, and the
  // message proves which one ran.
  const givenUp = refused(
    await updateUserRole(
      asClient(c),
      userRoleId,
      { effectiveTo: null, active: false, scopes: null },
      CTX,
    ),
  );
  assert.match(String(givenUp.fields[0]?.message), /nobody able to administer roles/);
  c.close();
});

test('an administrator cannot give themselves approval authority either', async () => {
  const c = await db();
  const mine = await createWorkflowAssignment(
    asClient(c),
    {
      workflowRoleId: 'WROLE-SO-FIN',
      userId: CTX.actorUserId,
      scopeType: 'GROUP',
      countryId: null,
      affiliateId: null,
      businessUnitId: null,
      priority: 100,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  const refusal = refused(mine);
  assert.match(String(refusal.fields[0]?.message), /yourself approval authority/i);
  assert.equal(
    query(
      c,
      `SELECT COUNT(*) AS n FROM workflow_role_assignments WHERE user_id = ? AND workflow_role_id = 'WROLE-SO-FIN'`,
      CTX.actorUserId,
    )[0]?.n,
    0,
  );

  // Somebody ELSE is fine, which is the point: authority is granted by another
  // person, which is what an audit trail is meant to be able to show.
  const theirs = await createWorkflowAssignment(
    asClient(c),
    {
      workflowRoleId: 'WROLE-SO-FIN',
      userId: SEED.james,
      scopeType: 'AFFILIATE',
      countryId: null,
      affiliateId: SEED.affKenya,
      businessUnitId: null,
      priority: 100,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
    },
    CTX,
  );
  assert.ok(theirs.ok, 'granting somebody else authority was refused');
  c.close();
});

// ---- job title mappings ----------------------------------------------------

test('a job title maps to default access and workflow roles, in two separate catalogues', async () => {
  const c = await db();
  const access = accepted(
    await createMapping(
      asClient(c),
      'ACCESS',
      { jobTitleId: SEED.titleFinanceManager, targetId: SEED.roleFinance, active: true },
      CTX,
    ),
  );
  assert.equal(access.kind, 'ACCESS');
  assert.equal(access.jobTitle, 'Finance Manager');
  assert.ok(access.targetName !== '', 'the mapping reads the role name, never a raw id');

  const workflow = accepted(
    await createMapping(
      asClient(c),
      'WORKFLOW',
      { jobTitleId: SEED.titleFinanceManager, targetId: 'WROLE-SO-FIN', active: true },
      CTX,
    ),
  );
  assert.equal(workflow.kind, 'WORKFLOW');
  assert.equal(workflow.targetName, 'SO Finance Approver');

  // TWO TABLES, NOT ONE WITH A DISCRIMINATOR. Neither read sees the other.
  assert.deepEqual(
    (await listMappings(asClient(c), 'ACCESS')).map((m) => m.targetId),
    [SEED.roleFinance],
  );
  assert.deepEqual(
    (await listMappings(asClient(c), 'WORKFLOW')).map((m) => m.targetId),
    ['WROLE-SO-FIN'],
  );

  const forTitle = await mappingsForTitle(asClient(c), SEED.titleFinanceManager);
  assert.equal(forTitle.access.length, 1);
  assert.equal(forTitle.workflow.length, 1);
  c.close();
});

test('the mapping catalogue starts empty and infers nothing from existing users', async () => {
  const c = await db();
  // Every seeded person already holds roles and a title. Nothing derived a
  // mapping from any of them: an existing assignment stays authoritative and a
  // guess about what it implies would be a default nobody configured.
  assert.deepEqual(await listMappings(asClient(c), 'ACCESS'), []);
  assert.deepEqual(await listMappings(asClient(c), 'WORKFLOW'), []);
  c.close();
});

test('a mapping is audited, may be switched off, and removing it revokes nobody', async () => {
  const c = await db();
  const mapping = accepted(
    await createMapping(
      asClient(c),
      'ACCESS',
      { jobTitleId: SEED.titleFinanceManager, targetId: SEED.roleFinance, active: true },
      CTX,
    ),
  );
  // Somebody holds the role for real. Nothing done to the CATALOGUE may touch
  // it, which is the property that makes a mapping safe to edit.
  accepted(
    await assignUserRole(
      asClient(c),
      SEED.james,
      {
        roleId: SEED.roleFinance,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        active: true,
        scopes: [
          {
            scopeType: 'AFFILIATE',
            countryId: null,
            affiliateId: SEED.affKenya,
            businessUnitId: null,
            teamId: null,
          },
        ],
      },
      CTX,
    ),
  );
  const before = query(
    c,
    `SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ? AND active = 1`,
    SEED.roleFinance,
  )[0]?.n;

  const off = accepted(await updateMapping(asClient(c), 'ACCESS', mapping.mappingId, false, CTX));
  assert.equal(off.active, false);
  assert.equal((await mappingsForTitle(asClient(c), SEED.titleFinanceManager)).access.length, 0);

  accepted(await deleteMapping(asClient(c), 'ACCESS', mapping.mappingId, CTX));
  assert.deepEqual(await listMappings(asClient(c), 'ACCESS'), []);

  assert.equal(
    query(
      c,
      `SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ? AND active = 1`,
      SEED.roleFinance,
    )[0]?.n,
    before,
    'removing a default revoked somebody’s role',
  );

  const events = query(
    c,
    // By rowid, which is insertion order. `event_at` is a second-resolution
    // timestamp and the ids are random hex, so all three land in the same
    // second and neither column orders them.
    `SELECT event_type FROM audit_events WHERE entity_type = 'JOB_TITLE_MAPPING' ORDER BY rowid`,
  ).map((row) => String(row.event_type));
  assert.deepEqual(events, [
    'JOB_TITLE_ROLE_MAPPING_CREATED',
    'JOB_TITLE_ROLE_MAPPING_UPDATED',
    'JOB_TITLE_ROLE_MAPPING_REMOVED',
  ]);
  c.close();
});

test('the same default cannot be added twice, and an unknown reference is refused', async () => {
  const c = await db();
  const input = { jobTitleId: SEED.titleFinanceManager, targetId: SEED.roleFinance, active: true };
  accepted(await createMapping(asClient(c), 'ACCESS', input, CTX));
  assert.equal(refused(await createMapping(asClient(c), 'ACCESS', input, CTX)).kind, 'conflict');

  const bad = refused(
    await createMapping(
      asClient(c),
      'ACCESS',
      { jobTitleId: 'JT-NOPE', targetId: 'ROLE-NOPE', active: true },
      CTX,
    ),
  );
  assert.deepEqual(
    bad.fields.map((f) => f.field).sort(),
    ['jobTitleId', 'targetId'],
    'both bad references are named',
  );
  c.close();
});

test('mappedRoleIds is what the apply endpoint checks a claim against', async () => {
  const c = await db();
  accepted(
    await createMapping(
      asClient(c),
      'ACCESS',
      { jobTitleId: SEED.titleFinanceManager, targetId: SEED.roleFinance, active: true },
      CTX,
    ),
  );
  const allowed = await mappedRoleIds(asClient(c), 'ACCESS', SEED.titleFinanceManager);
  assert.ok(allowed.has(SEED.roleFinance));
  // The administrator role is NOT a default for this title, so a payload
  // naming it is refused by the endpoint however it was produced.
  assert.equal(allowed.has(SEED.roleAdmin), false);

  // A mapping switched off, or pointing at a deactivated role, is not offered.
  await c.execute({
    sql: `UPDATE access_roles SET active = 0 WHERE role_id = ?`,
    args: [SEED.roleFinance],
  });
  assert.equal(
    (await mappedRoleIds(asClient(c), 'ACCESS', SEED.titleFinanceManager)).size,
    0,
    'a default pointing at a dead role was still offered',
  );
  c.close();
});

// ---- applying the defaults -------------------------------------------------

test('applying defaults requires an explicit scope for every role and never assumes GROUP', () => {
  // No scope at all.
  const bare = validateApplyDefaults({
    jobTitleId: 'JT-FM',
    roles: [{ roleId: 'ROLE-FIN' }],
  });
  assert.equal(bare.ok, false);
  assert.match(String(bare.ok === false && bare.errors[0]?.message), /Choose a data scope/);

  // A scope whose target is missing.
  const untargeted = validateApplyDefaults({
    jobTitleId: 'JT-FM',
    roles: [{ roleId: 'ROLE-FIN', scopeType: 'AFFILIATE' }],
  });
  assert.equal(untargeted.ok, false);
  assert.match(
    String(untargeted.ok === false && untargeted.errors[0]?.field),
    /roles\.0\.affiliateId/,
  );

  // A complete one is accepted exactly as sent — nothing is widened, and the
  // excluded columns are null rather than empty strings the CHECK would reject.
  const good = validateApplyDefaults({
    jobTitleId: 'JT-FM',
    roles: [{ roleId: 'ROLE-FIN', scopeType: 'AFFILIATE', affiliateId: 'AFF-KE' }],
  });
  assert.ok(good.ok);
  assert.deepEqual(good.value.roles, [
    {
      roleId: 'ROLE-FIN',
      scopeType: 'AFFILIATE',
      countryId: null,
      affiliateId: 'AFF-KE',
      businessUnitId: null,
      teamId: null,
    },
  ]);

  // NOTHING DEFAULTS. An empty payload asks for nothing rather than for
  // everything the title carries.
  assert.equal(validateApplyDefaults({ jobTitleId: 'JT-FM' }).ok, false);
});

test('workflow authority is validated apart from access roles and takes its own scopes', () => {
  // OWN and TEAM are role scopes. Approval authority is organisational, and
  // `workflow_role_assignments` carries the CHECK that says so.
  const wrong = validateApplyDefaults({
    jobTitleId: 'JT-FM',
    authorities: [{ workflowRoleId: 'WROLE-SO-FIN', scopeType: 'TEAM', teamId: 'TEAM-1' }],
  });
  assert.equal(wrong.ok, false);
  assert.match(String(wrong.ok === false && wrong.errors[0]?.field), /authorities\.0\.scopeType/);

  const right = validateApplyDefaults({
    jobTitleId: 'JT-FM',
    authorities: [
      { workflowRoleId: 'WROLE-SO-FIN', scopeType: 'AFFILIATE', affiliateId: 'AFF-KE' },
    ],
  });
  assert.ok(right.ok);
  assert.equal(right.value.roles.length, 0, 'an authority is not also an access role');
  assert.deepEqual(right.value.authorities, [
    {
      workflowRoleId: 'WROLE-SO-FIN',
      scopeType: 'AFFILIATE',
      countryId: null,
      affiliateId: 'AFF-KE',
      businessUnitId: null,
    },
  ]);
});

test('a mapping cannot be created from free text', () => {
  assert.equal(validateMapping({ jobTitleId: '', targetId: '' }).ok, false);
  assert.equal(validateMapping({ jobTitleId: 'JT-FM', targetId: '' }).ok, false);
  assert.ok(validateMapping({ jobTitleId: 'JT-FM', targetId: 'ROLE-FIN' }).ok);
});

// ---- the endpoints and the screen ------------------------------------------

test('every write endpoint checks its own permission before anything else', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  // A job title is organisational position and grants nothing, so it sits with
  // the permission that administers people.
  const title = read('src/pages/cms/api/admin/users/[id]/job-title.ts');
  assert.match(title, /requireUsersManage\(context\)/);
  assert.match(title, /if \(!auth\.ok\) return auth\.response;/);
  // The subject comes from the path. A userId in the body is inert.
  assert.match(title, /context\.params\.id/);
  assert.ok(!/body[^\n]*userId/.test(title));

  // The mapping catalogue is role administration.
  for (const path of [
    'src/pages/cms/api/admin/job-title-mappings/index.ts',
    'src/pages/cms/api/admin/job-title-mappings/[id].ts',
  ]) {
    const source = read(path);
    assert.match(source, /requireRolesManage\(context\)/);
    assert.ok(!/requireUsersManage/.test(source), `${path} accepts the wrong permission`);
  }

  // Applying defaults checks the two capabilities SEPARATELY, against what the
  // request actually asks for.
  const apply = read('src/pages/cms/api/admin/users/[id]/apply-title-defaults.ts');
  assert.match(apply, /roles\.length > 0 && !canManageRoles\(permissions\)/);
  assert.match(apply, /authorities\.length > 0 && !canManageWorkflowRoles\(permissions\)/);
  assert.match(apply, /mappedRoleIds\(connection\.db, 'ACCESS', jobTitleId\)/);
  assert.match(apply, /not a default for this job title/);
  assert.match(apply, /userId === ctx\.actorUserId/);
});

test('no direct user permission or title permission store was created', () => {
  // The whole design rests on a permission belonging to a role and to nothing
  // else, so there is one place to configure it and no way for a role to say
  // NO while an override says YES.
  const schema = readFileSync('test/cms/support/schema.ts', 'utf8');
  assert.ok(!/CREATE TABLE IF NOT EXISTS user_permissions/.test(schema));
  assert.ok(!/CREATE TABLE IF NOT EXISTS job_title_permissions/.test(schema));
  assert.match(schema, /CREATE TABLE IF NOT EXISTS job_title_access_role_mappings/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS job_title_workflow_role_mappings/);
  // Both mapping tables carry the uniqueness rule and the foreign keys.
  assert.match(schema, /UNIQUE\(job_title_id, role_id\)/);
  assert.match(schema, /UNIQUE\(job_title_id, workflow_role_id\)/);

  // And nothing in the permission or approval path reads either of them.
  for (const path of [
    'src/lib/cms/auth/rbac.ts',
    'src/lib/cms/permissions.ts',
    'src/lib/cms/workflow/model.ts',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.ok(
      !/job_title_access_role_mappings|job_title_workflow_role_mappings/.test(source),
      `${path} resolves access from a job title`,
    );
  }
});

test('the panel keeps the four tabs and shows an external user no internal position', () => {
  const page = readFileSync('src/pages/cms/app/administration/users/[id].astro', 'utf8');
  for (const label of ['Assignments', 'Roles', 'Workflow authority']) {
    assert.match(page, new RegExp(`label: '${label}'`), `the ${label} tab was removed`);
  }
  const panel = readFileSync('src/components/cms/CmsUserAccessPanel.astro', 'utf8');
  assert.match(panel, /const external = userType === 'EXTERNAL';/);
  assert.match(panel, /Customer portal account\. No internal position or authority\./);
  // Read-only where the viewer holds the user permission and not the others.
  assert.match(panel, /mayManageRoles && !isSelf/, 'the add-role control is gated');
  assert.match(panel, /mayManageAuthority && !isSelf/, 'the add-authority control is gated');
  assert.match(panel, /\{!mayManageAuthority && <p[^>]*>Read-only for you\.<\/p>\}/);
});

test('the mapping screen shows what a default would grant before it is saved', () => {
  const source = readFileSync('src/components/cms/CmsJobTitleMappings.astro', 'utf8');
  // The count, and the list one disclosure away. "Finance Manager Access" says
  // nothing on its own; "12 permissions" is the reason to map it or not.
  assert.match(source, /const countOf = \(roleId: string\)/);
  assert.match(source, /permission' : 'permissions'/);
  // Chosen, never typed.
  assert.ok(!/type="text"/.test(source), 'the mapping form takes a typed id');
  assert.match(source, /This grants nobody anything/);
});
