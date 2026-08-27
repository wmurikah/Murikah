/**
 * The organisation master data, against a real database.
 *
 * An isolated in-memory SQLite built from the operator's own DDL, constraints
 * included, so these assertions are about what the code does rather than what
 * it intends. A UNIQUE that is only in the prose would pass a test written
 * against a relaxed copy of the schema. Nothing here points at hass-cms.
 *
 * The audit assertions matter more than usual in this phase: none of these six
 * tables has an `updated_at` column, so `audit_events` is the only record that
 * a row ever changed. Every mutation test therefore also asserts its audit row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedOrganisation, ORG_IDS } from './support/orgSeed.ts';
import {
  addTeamMember,
  createAffiliate,
  createCountry,
  createDepartment,
  createTeam,
  endTeamMembership,
  getTeamMember,
  listAffiliates,
  listCountries,
  listDepartments,
  listTeamMembers,
  listTeams,
  updateAffiliate,
  updateBusinessUnit,
  updateCountry,
  updateTeam,
} from '../../src/lib/cms/repos/organisationAdmin.ts';
import {
  validateAffiliate,
  validateCountry,
  validateTeam,
  validateTeamMember,
} from '../../src/lib/cms/admin/organisationInput.ts';

const NOW = new Date('2026-08-27T09:00:00Z');
const CTX = {
  actorUserId: ORG_IDS.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const db = async (): Promise<TestClient> => {
  const client = createTestDb();
  await seedOrganisation(client);
  return client;
};
// The repositories take the libSQL Client interface; the adapter implements the
// slice this product uses. One cast at the boundary rather than one per call.
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listCountries>[0];

/** Every audit row, newest last, for the assertions each mutation test makes. */
const audits = (c: TestClient) =>
  query(c, `SELECT * FROM audit_events ORDER BY audit_event_id`) as Record<string, unknown>[];

const valid = <T>(result: { ok: true; value: T } | { ok: false; errors: unknown }): T => {
  assert.ok(result.ok, `expected valid input, got ${JSON.stringify(result)}`);
  return result.value;
};

/**
 * The refusal half of a WriteResult, with its field messages.
 *
 * A helper rather than an inline assertion because `not_found` carries no
 * fields, so reading `result.fields` after only asserting that the write failed
 * does not type-check. Narrowing here once keeps the tests readable and keeps
 * the union honest.
 */
function refused<T>(
  result: import('../../src/lib/cms/repos/organisationAdmin.ts').WriteResult<T>,
): { kind: string; fields: { field: string; message: string }[] } {
  assert.ok(!result.ok, `expected a refusal, got ${JSON.stringify(result)}`);
  return { kind: result.kind, fields: result.kind === 'not_found' ? [] : result.fields };
}

// ---- countries -------------------------------------------------------------

test('a country is created, and the create is audited', async () => {
  const c = await db();
  const input = valid(
    validateCountry({
      iso2: 'tz',
      countryName: 'Tanzania',
      timezone: 'Africa/Dar_es_Salaam',
      currencyCode: 'tzs',
    }),
  );
  // Lower case in, upper case stored: accepted and normalised rather than
  // refused, which is the house style in src/lib/validation.ts.
  assert.equal(input.iso2, 'TZ');
  assert.equal(input.currencyCode, 'TZS');

  const result = await createCountry(asClient(c), input, CTX);
  assert.ok(result.ok);
  assert.equal(result.value.iso2, 'TZ');
  assert.equal(result.value.active, true);
  assert.equal(result.value.affiliateCount, 0);

  const rows = audits(c);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.entity_type, 'COUNTRY');
  assert.equal(rows[0]?.entity_id, result.value.countryId);
  assert.equal(rows[0]?.action, 'CREATE');
  assert.equal(rows[0]?.actor_user_id, ORG_IDS.admin);
  assert.equal(rows[0]?.before_json, null);
  assert.equal(JSON.parse(String(rows[0]?.after_json)).countryName, 'Tanzania');
  c.close();
});

test('a duplicate ISO2 is a field message, not a 500', async () => {
  const c = await db();
  const input = valid(
    validateCountry({
      iso2: 'KE',
      countryName: 'Kenya Republic',
      timezone: 'Africa/Nairobi',
      currencyCode: 'KES',
    }),
  );
  const result = refused(await createCountry(asClient(c), input, CTX));
  assert.equal(result.kind, 'conflict');
  assert.deepEqual(
    result.fields.map((f) => f.field),
    ['iso2'],
  );
  // Nothing was written, and nothing was audited.
  assert.equal(listOf(c, 'countries').length, 3);
  assert.equal(audits(c).length, 0);
  c.close();
});

test('a duplicate country name is a field message on the name', async () => {
  const c = await db();
  const input = valid(
    validateCountry({
      iso2: 'KX',
      countryName: 'Kenya',
      timezone: 'Africa/Nairobi',
      currencyCode: 'KES',
    }),
  );
  const result = refused(await createCountry(asClient(c), input, CTX));
  assert.deepEqual(
    result.fields.map((f) => f.field),
    ['countryName'],
  );
  c.close();
});

test('an ISO2 of one or three characters is rejected before the database sees it', async () => {
  for (const iso2 of ['K', 'KEN', '', '12']) {
    const result = validateCountry({
      iso2,
      countryName: 'Somewhere',
      timezone: 'Africa/Nairobi',
      currencyCode: 'KES',
    });
    assert.ok(!result.ok, `${iso2} must be rejected`);
    assert.equal(result.errors[0]?.field, 'iso2');
  }
});

test('a timezone and a currency are both required', async () => {
  const noZone = validateCountry({ iso2: 'ZM', countryName: 'Zambia', currencyCode: 'ZMW' });
  assert.ok(!noZone.ok);
  assert.equal(noZone.errors[0]?.field, 'timezone');

  const noCurrency = validateCountry({
    iso2: 'ZM',
    countryName: 'Zambia',
    timezone: 'Africa/Lusaka',
  });
  assert.ok(!noCurrency.ok);
  assert.equal(noCurrency.errors[0]?.field, 'currencyCode');
});

test('deactivating a country records the before state and the DEACTIVATE action', async () => {
  const c = await db();
  const input = valid(
    validateCountry({
      iso2: 'UG',
      countryName: 'Uganda',
      timezone: 'Africa/Kampala',
      currencyCode: 'UGX',
      active: false,
    }),
  );
  const result = await updateCountry(asClient(c), ORG_IDS.uganda, input, CTX);
  assert.ok(result.ok);
  assert.equal(result.value.active, false);

  const row = audits(c)[0];
  assert.equal(row?.action, 'DEACTIVATE');
  assert.equal(JSON.parse(String(row?.before_json)).active, true);
  assert.equal(JSON.parse(String(row?.after_json)).active, false);

  // The affiliates are still there. Deactivation does not cascade.
  const affiliates = listOf(c, 'affiliates').filter((a) => a.country_id === ORG_IDS.uganda);
  assert.equal(affiliates.length, 1);
  assert.equal(affiliates[0]?.active, 1);
  c.close();
});

test('a country reports how many affiliates would lose it', async () => {
  const c = await db();
  const rows = await listCountries(asClient(c));
  const kenya = rows.find((r) => r.countryId === ORG_IDS.kenya);
  // Two affiliates in one country. One per country is an assumption the real
  // data breaks, and a count that said 1 would be reporting the assumption.
  assert.equal(kenya?.affiliateCount, 2);
  c.close();
});

// ---- affiliates ------------------------------------------------------------

test('an affiliate is edited, and the edit is audited with both states', async () => {
  const c = await db();
  const input = valid(
    validateAffiliate({
      affiliateCode: 'HKE',
      affiliateName: 'Hass Petroleum Kenya Limited',
      countryId: ORG_IDS.kenya,
      active: true,
    }),
  );
  const result = await updateAffiliate(asClient(c), ORG_IDS.hassKenya, input, CTX);
  assert.ok(result.ok);
  assert.equal(result.value.affiliateName, 'Hass Petroleum Kenya Limited');
  assert.equal(result.value.countryName, 'Kenya');

  const row = audits(c)[0];
  assert.equal(row?.entity_type, 'AFFILIATE');
  assert.equal(row?.action, 'UPDATE');
  assert.equal(JSON.parse(String(row?.before_json)).affiliateName, 'Hass Petroleum Kenya');
  assert.equal(JSON.parse(String(row?.after_json)).affiliateName, 'Hass Petroleum Kenya Limited');
  c.close();
});

test('a duplicate affiliate code is refused and a duplicate affiliate name is not', async () => {
  const c = await db();

  // The code is UNIQUE in the schema.
  const clashing = valid(
    validateAffiliate({
      affiliateCode: 'HKE',
      affiliateName: 'Something Else',
      countryId: ORG_IDS.uganda,
    }),
  );
  const refused = await createAffiliate(asClient(c), clashing, CTX);
  assert.ok(!refused.ok);
  assert.equal(refused.kind, 'conflict');
  assert.equal(refused.fields[0]?.field, 'affiliateCode');

  // The name is not. Two affiliates trading under one name in two countries is
  // a real arrangement, and blocking it would be inventing a constraint the
  // operator did not write.
  const sameName = valid(
    validateAffiliate({
      affiliateCode: 'HTZ',
      affiliateName: 'Hass Petroleum Kenya',
      countryId: ORG_IDS.uganda,
    }),
  );
  const accepted = await createAffiliate(asClient(c), sameName, CTX);
  assert.ok(accepted.ok);
  assert.equal(accepted.value.affiliateName, 'Hass Petroleum Kenya');

  const names = (await listAffiliates(asClient(c))).filter(
    (a) => a.affiliateName === 'Hass Petroleum Kenya',
  );
  assert.equal(names.length, 2);
  c.close();
});

test('an affiliate cannot be created against a deactivated country', async () => {
  const c = await db();
  const input = valid(
    validateAffiliate({
      affiliateCode: 'DOR',
      affiliateName: 'Dormant Affiliate',
      countryId: ORG_IDS.dormant,
    }),
  );
  const result = await createAffiliate(asClient(c), input, CTX);
  assert.ok(!result.ok);
  assert.equal(result.kind, 'invalid_reference');
  assert.equal(result.fields[0]?.field, 'countryId');
  assert.match(String(result.fields[0]?.message), /deactivated/);
  c.close();
});

test('an affiliate already on a deactivated country stays editable', async () => {
  const c = await db();
  // Arrange: an affiliate whose country is then deactivated.
  await createAffiliate(
    asClient(c),
    valid(
      validateAffiliate({
        affiliateCode: 'UGX2',
        affiliateName: 'Uganda Second',
        countryId: ORG_IDS.uganda,
      }),
    ),
    CTX,
  );
  const created = (await listAffiliates(asClient(c))).find((a) => a.affiliateCode === 'UGX2');
  assert.ok(created);
  await updateCountry(
    asClient(c),
    ORG_IDS.uganda,
    valid(
      validateCountry({
        iso2: 'UG',
        countryName: 'Uganda',
        timezone: 'Africa/Kampala',
        currencyCode: 'UGX',
        active: false,
      }),
    ),
    CTX,
  );

  // Renaming it must still work. The country did not change, so the "must be
  // active" rule does not apply; otherwise deactivating a country would make
  // every affiliate under it permanently uneditable.
  const result = await updateAffiliate(
    asClient(c),
    created.affiliateId,
    valid(
      validateAffiliate({
        affiliateCode: 'UGX2',
        affiliateName: 'Uganda Second Renamed',
        countryId: ORG_IDS.uganda,
      }),
    ),
    CTX,
  );
  assert.ok(result.ok);
  assert.equal(result.value.affiliateName, 'Uganda Second Renamed');
  c.close();
});

// ---- business units and departments ---------------------------------------

test('a business unit is deactivated, and the row survives with active = 0', async () => {
  const c = await db();
  const result = await updateBusinessUnit(
    asClient(c),
    ORG_IDS.retail,
    { businessUnitCode: 'RET', businessUnitName: 'Retail', description: null, active: false },
    CTX,
  );
  assert.ok(result.ok);
  assert.equal(result.value.active, false);

  const rows = listOf(c, 'business_units').filter((b) => b.business_unit_id === ORG_IDS.retail);
  assert.equal(rows.length, 1, 'the row must still exist');
  assert.equal(rows[0]?.active, 0);
  assert.equal(audits(c)[0]?.action, 'DEACTIVATE');
  c.close();
});

test('a business unit reports the teams and assignments that reference it', async () => {
  const c = await db();
  const result = await updateBusinessUnit(
    asClient(c),
    ORG_IDS.retail,
    { businessUnitCode: 'RET', businessUnitName: 'Retail', description: null, active: true },
    CTX,
  );
  assert.ok(result.ok);
  // Kenya Sales sits in Retail, and one user is assigned to it. Deactivating
  // blind is the thing section 13 exists to prevent.
  assert.equal(result.value.teamCount, 1);
  assert.equal(result.value.assignmentCount, 1);
  c.close();
});

test('a department is created and its name must be unique', async () => {
  const c = await db();
  const created = await createDepartment(
    asClient(c),
    {
      departmentName: 'Procurement',
      description: 'Sourcing and supplier management',
      active: true,
    },
    CTX,
  );
  assert.ok(created.ok);
  assert.equal(created.value.departmentName, 'Procurement');
  assert.equal(audits(c)[0]?.entity_type, 'DEPARTMENT');

  const duplicate = await createDepartment(
    asClient(c),
    { departmentName: 'Procurement', description: null, active: true },
    CTX,
  );
  assert.ok(!duplicate.ok);
  assert.equal(duplicate.kind, 'conflict');
  assert.equal(duplicate.fields[0]?.field, 'departmentName');
  c.close();
});

test('a department counts the job titles that would be stranded', async () => {
  const c = await db();
  const rows = await listDepartments(asClient(c));

  // Customer Service carries a job title, and a user is assigned through it.
  // Job titles are linked to departments in a later phase; the column is
  // already populated, so a deactivation that would strand one is counted now
  // rather than discovered then.
  const customerService = rows.find((d) => d.departmentId === ORG_IDS.customerService);
  assert.equal(customerService?.jobTitleCount, 1);
  assert.equal(customerService?.assignmentCount, 1);

  // Finance carries neither, so the count is a real count and not a constant.
  const finance = rows.find((d) => d.departmentId === ORG_IDS.finance);
  assert.equal(finance?.jobTitleCount, 0);
  assert.equal(finance?.assignmentCount, 0);
  c.close();
});

// ---- teams -----------------------------------------------------------------

test('a team is created with no manager', async () => {
  const c = await db();
  const input = valid(validateTeam({ teamName: 'Group Procurement', teamType: 'PROCUREMENT' }));
  assert.equal(input.managerUserId, null);
  assert.equal(input.affiliateId, null);
  assert.equal(input.businessUnitId, null);

  const result = await createTeam(asClient(c), input, CTX);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.managerUserId, null);
  assert.equal(result.value.managerName, null);
  assert.equal(result.value.affiliateId, null);

  const row = listOf(c, 'teams').find((t) => t.team_id === result.value.teamId);
  assert.equal(row?.manager_user_id, null);
  assert.equal(row?.affiliate_id, null);
  assert.equal(row?.business_unit_id, null);
  c.close();
});

test('a team is created with an affiliate and no business unit, and with both', async () => {
  const c = await db();

  const affiliateOnly = await createTeam(
    asClient(c),
    valid(
      validateTeam({
        teamName: 'Uganda Credit',
        teamType: 'CREDIT',
        affiliateId: ORG_IDS.hassUganda,
      }),
    ),
    CTX,
  );
  assert.ok(affiliateOnly.ok);
  assert.equal(affiliateOnly.value.affiliateName, 'Hass Petroleum Uganda');
  assert.equal(affiliateOnly.value.businessUnitId, null);

  const both = await createTeam(
    asClient(c),
    valid(
      validateTeam({
        teamName: 'Kenya Aviation Ops',
        teamType: 'OPERATIONS',
        affiliateId: ORG_IDS.hassKenya,
        businessUnitId: ORG_IDS.aviation,
      }),
    ),
    CTX,
  );
  assert.ok(both.ok);
  assert.equal(both.value.affiliateName, 'Hass Petroleum Kenya');
  assert.equal(both.value.businessUnitName, 'Aviation');
  c.close();
});

test('the team list keeps the Group team that has neither affiliate nor unit', async () => {
  const c = await db();
  const teams = await listTeams(asClient(c));
  const group = teams.find((t) => t.teamId === ORG_IDS.groupFinance);
  // An INNER JOIN on affiliates would have dropped this row entirely, and the
  // list would look correct while silently hiding every Group-wide team.
  assert.ok(group, 'the Group team must appear in the list');
  assert.equal(group.affiliateId, null);
  assert.equal(group.businessUnitId, null);
  assert.equal(teams.length, 3);
  c.close();
});

test('a team manager is assigned, and must be an active staff user', async () => {
  const c = await db();

  const assigned = await updateTeam(
    asClient(c),
    ORG_IDS.groupFinance,
    valid(
      validateTeam({
        teamName: 'Group Finance',
        teamType: 'FINANCE',
        managerUserId: ORG_IDS.manager,
      }),
    ),
    CTX,
  );
  assert.ok(assigned.ok);
  assert.equal(assigned.value.managerUserId, ORG_IDS.manager);
  assert.equal(assigned.value.managerName, 'Amina Noor');
  assert.equal(JSON.parse(String(audits(c)[0]?.before_json)).managerUserId, null);

  // A customer portal contact is not a candidate, even though the foreign key
  // would accept one.
  const external = await updateTeam(
    asClient(c),
    ORG_IDS.groupFinance,
    valid(
      validateTeam({
        teamName: 'Group Finance',
        teamType: 'FINANCE',
        managerUserId: ORG_IDS.portal,
      }),
    ),
    CTX,
  );
  assert.ok(!external.ok);
  assert.equal(external.kind, 'invalid_reference');
  assert.equal(external.fields[0]?.field, 'managerUserId');
  c.close();
});

test('a team type outside the eight allowed values is rejected', async () => {
  const result = validateTeam({ teamName: 'Nowhere', teamType: 'MARKETING' });
  assert.ok(!result.ok);
  assert.equal(result.errors[0]?.field, 'teamType');
});

// ---- membership ------------------------------------------------------------

test('a member is added and appears as current', async () => {
  const c = await db();
  const input = valid(
    validateTeamMember({ userId: ORG_IDS.member, memberRole: 'Analyst' }, '2026-08-27'),
  );
  const result = await addTeamMember(asClient(c), ORG_IDS.kenyaFinance, input, CTX);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.userId, ORG_IDS.member);
  assert.equal(result.value.displayName, 'Zuleika Omar');
  assert.equal(result.value.effectiveTo, null);
  assert.equal(result.value.current, true);

  const current = await listTeamMembers(asClient(c), ORG_IDS.kenyaFinance);
  assert.equal(current.length, 1);
  assert.equal(audits(c)[0]?.entity_type, 'TEAM_MEMBER');
  assert.equal(audits(c)[0]?.action, 'CREATE');
  c.close();
});

test('removing a member end-dates the row and never deletes it', async () => {
  const c = await db();
  const added = await addTeamMember(
    asClient(c),
    ORG_IDS.kenyaFinance,
    valid(validateTeamMember({ userId: ORG_IDS.member, memberRole: 'Analyst' }, '2026-08-27')),
    CTX,
  );
  assert.ok(added.ok);
  const id = added.value.teamMemberId;

  const before = listOf(c, 'team_members').find((m) => m.team_member_id === id);
  assert.equal(before?.effective_to, null);
  assert.equal(before?.active, 1);

  const ended = await endTeamMembership(asClient(c), id, '2026-09-30', CTX);
  assert.ok(ended.ok);

  const after = listOf(c, 'team_members').find((m) => m.team_member_id === id);
  assert.ok(after, 'the row must still exist after removal');
  assert.equal(after.effective_to, '2026-09-30');
  assert.equal(after.active, 0);

  // Gone from the current list, still in the historical one.
  assert.equal((await listTeamMembers(asClient(c), ORG_IDS.kenyaFinance)).length, 0);
  const history = await listTeamMembers(asClient(c), ORG_IDS.kenyaFinance, true);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.current, false);

  // Selected by action, not by position. `audit_events` records `event_at` to
  // the second and gives the row a random id, so the add and the removal have
  // no deterministic order when they happen in the same second. That is a
  // property of the operator's table, not of this code, and this phase may not
  // change it; asserting on `.at(-1)` passes or fails on a coin toss.
  const written = audits(c);
  assert.equal(written.length, 2, 'the add and the removal are both recorded');
  const removal = written.find((row) => row.action === 'DEACTIVATE');
  assert.ok(removal, 'the removal must be audited');
  assert.equal(removal.entity_id, id);
  assert.equal(JSON.parse(String(removal.after_json)).effectiveTo, '2026-09-30');
  assert.equal(JSON.parse(String(removal.before_json)).effectiveTo, null);
  c.close();
});

test('re-adding the same person on the same date is a validation message', async () => {
  const c = await db();
  const input = valid(validateTeamMember({ userId: ORG_IDS.member }, '2026-08-27'));
  const first = await addTeamMember(asClient(c), ORG_IDS.kenyaFinance, input, CTX);
  assert.ok(first.ok);

  const second = await addTeamMember(asClient(c), ORG_IDS.kenyaFinance, input, CTX);
  assert.ok(!second.ok, 'UNIQUE(team_id, user_id, effective_from) must be reported, not thrown');
  assert.equal(second.kind, 'conflict');
  assert.equal(second.fields[0]?.field, 'effectiveFrom');

  // And only the one row was written.
  assert.equal(listOf(c, 'team_members').length, 1);
  c.close();
});

test('the same person can rejoin the same team on a later date', async () => {
  const c = await db();
  const first = await addTeamMember(
    asClient(c),
    ORG_IDS.kenyaFinance,
    valid(validateTeamMember({ userId: ORG_IDS.member }, '2026-01-01')),
    CTX,
  );
  assert.ok(first.ok);
  await endTeamMembership(asClient(c), first.value.teamMemberId, '2026-06-30', CTX);

  const second = await addTeamMember(
    asClient(c),
    ORG_IDS.kenyaFinance,
    valid(validateTeamMember({ userId: ORG_IDS.member }, '2026-08-27')),
    CTX,
  );
  assert.ok(second.ok, 'history is the point of effective dating; rejoining must work');

  const history = await listTeamMembers(asClient(c), ORG_IDS.kenyaFinance, true);
  assert.equal(history.length, 2);
  assert.equal(history.filter((m) => m.current).length, 1);
  c.close();
});

test('an end date before the start date is refused', async () => {
  const c = await db();
  const added = await addTeamMember(
    asClient(c),
    ORG_IDS.kenyaFinance,
    valid(validateTeamMember({ userId: ORG_IDS.member }, '2026-08-27')),
    CTX,
  );
  assert.ok(added.ok);

  const result = refused(
    await endTeamMembership(asClient(c), added.value.teamMemberId, '2026-01-01', CTX),
  );
  assert.equal(result.fields[0]?.field, 'effectiveTo');

  const row = await getTeamMember(asClient(c), added.value.teamMemberId);
  assert.equal(row?.effectiveTo, null, 'the refused edit must not have written anything');
  c.close();
});

// ---- what these endpoints must never return --------------------------------

test('no row these repositories return carries a hash, token or secret', async () => {
  const c = await db();
  await addTeamMember(
    asClient(c),
    ORG_IDS.kenyaFinance,
    valid(validateTeamMember({ userId: ORG_IDS.member }, '2026-08-27')),
    CTX,
  );
  const payload = JSON.stringify({
    countries: await listCountries(asClient(c)),
    affiliates: await listAffiliates(asClient(c)),
    teams: await listTeams(asClient(c)),
    members: await listTeamMembers(asClient(c), ORG_IDS.kenyaFinance, true),
  });
  // These queries join `users`, which holds a password hash. A SELECT u.* would
  // put it one spread away from a response body.
  for (const forbidden of [
    'password_hash',
    'refresh_token_hash',
    'secret_encrypted',
    'token_hash',
    'passwordHash',
  ]) {
    assert.ok(!payload.includes(forbidden), `a payload must not contain ${forbidden}`);
  }
  c.close();
});

test('a read writes no audit row', async () => {
  const c = await db();
  await listCountries(asClient(c));
  await listAffiliates(asClient(c));
  await listTeams(asClient(c));
  await listTeamMembers(asClient(c), ORG_IDS.kenyaSales, true);
  assert.equal(audits(c).length, 0, 'reads are not configuration changes');
  c.close();
});

test('a refused write leaves no audit row and no data row', async () => {
  const c = await db();
  const before = listOf(c, 'countries').length;
  await createCountry(
    asClient(c),
    valid(
      validateCountry({
        iso2: 'KE',
        countryName: 'Duplicate',
        timezone: 'Africa/Nairobi',
        currencyCode: 'KES',
      }),
    ),
    CTX,
  );
  assert.equal(listOf(c, 'countries').length, before);
  assert.equal(audits(c).length, 0);
  c.close();
});

/** Raw rows from a table, for assertions about what is actually stored. */
function listOf(c: TestClient, table: string): Record<string, unknown>[] {
  return query(c, `SELECT * FROM ${table}`);
}
