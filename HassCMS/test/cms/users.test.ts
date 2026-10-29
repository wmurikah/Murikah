/**
 * User administration, against the operator's own seed.
 *
 * An isolated in-memory SQLite built from the operator's DDL and loaded with
 * the operator's seed rows, so "Gabriel Musembi is the Kenya Finance Manager"
 * is a statement about the data this product will actually run against rather
 * than about a fixture that paraphrased it. Nothing here points at hass-cms.
 *
 * Two constraints do most of the work in this file, and both are the
 * database's rather than this code's:
 *
 *   users has CHECK(status != 'ACTIVE' OR email_verified_at IS NOT NULL)
 *   user_assignments has a CHECK tying assignment_level to its location column
 *
 * Where a test says something is refused, it is refused with a field message
 * before the database is reached, and the constraint remains as the backstop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  createAssignment,
  createJobTitle,
  createUser,
  getUser,
  listAssignments,
  listJobTitles,
  listUsers,
  listUserRoles,
  listWorkflowAuthority,
  getSecurity,
  mapSourceIdentity,
  updateAssignment,
  updateUser,
  STATUS_AFTER_EMAIL_CHANGE,
  type WriteResult,
} from '../../src/lib/cms/repos/userAdmin.ts';
import {
  validateAssignment,
  validateCreateUser,
  validateSourceIdentity,
  validateUpdateUser,
} from '../../src/lib/cms/admin/userInput.ts';
import { organisationLine } from '../../src/lib/cms/organisation.ts';

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
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listUsers>[0];

/** A verification token stand-in. The repository never sees a raw token twice. */
const invitation = (suffix = '1') => ({
  tokenId: `EVT-test-${suffix}`,
  tokenHash: `hash-${suffix}-${crypto.randomUUID()}`,
  issuedAt: '2026-08-27 09:00:00',
  expiresAt: '2026-09-03 09:00:00',
  rawToken: `raw-${suffix}`,
});

const valid = <T>(r: { ok: true; value: T } | { ok: false; errors: unknown }): T => {
  assert.ok(r.ok, `expected valid input, got ${JSON.stringify(r)}`);
  return r.value;
};
const refused = <T>(
  r: WriteResult<T>,
): { kind: string; fields: { field: string; message: string }[] } => {
  assert.ok(!r.ok, `expected a refusal, got ${JSON.stringify(r)}`);
  return { kind: r.kind, fields: r.kind === 'not_found' ? [] : r.fields };
};
const audits = (c: TestClient) => query(c, `SELECT * FROM audit_events`);

// ---- the five distinct people --------------------------------------------

test('the directory shows five people whose titles collide and whose contexts do not', async () => {
  const c = await db();
  const page = await listUsers(asClient(c), {});
  const named = [
    'Gabriel Musembi',
    'Grace Atieno',
    'Amina Yusuf',
    'Daniel Okello',
    'Hassan Ali',
  ].map((name) => page.items.find((u) => u.displayName === name));
  for (const row of named) assert.ok(row, 'every named person must appear');

  const [gabriel, grace, amina, daniel, hassan] = named as NonNullable<(typeof named)[number]>[];

  // Two Finance Managers, two Country Managers. A title held by one person is
  // an assumption the seeded data breaks and nothing here may make.
  assert.equal(gabriel.jobTitle, 'Finance Manager');
  assert.equal(gabriel.affiliateName, 'Hass Petroleum Kenya');
  assert.equal(grace.jobTitle, 'Finance Manager');
  assert.equal(grace.affiliateName, 'Hass Petroleum Uganda');
  assert.equal(amina.jobTitle, 'Country Manager');
  assert.equal(amina.affiliateName, 'Hass Petroleum Kenya');
  assert.equal(daniel.jobTitle, 'Country Manager');
  assert.equal(daniel.affiliateName, 'Hass Petroleum Uganda');
  assert.equal(hassan.jobTitle, 'Group CFO');
  assert.equal(hassan.assignmentLevel, 'GROUP');
  assert.equal(hassan.affiliateName, null);

  // FOUR people hold Finance Manager in the seeded data, not three. Build
  // Prompt 06 says three; the rows say Gabriel Musembi (Kenya, AFFILIATE),
  // Zuleika Omar (Kenya Retail, BUSINESS_UNIT), Grace Atieno (Uganda) and Neema
  // Hassan (Tanzania). The count is asserted against the data rather than
  // against the sentence, because the rule being tested is that a title is held
  // by however many people hold it.
  const financeManager = (await listJobTitles(asClient(c))).find(
    (t) => t.titleName === 'Finance Manager',
  );
  assert.equal(financeManager?.holderCount, 4);
  c.close();
});

test('a GROUP assignment renders as the group, with no null and no dangling separator', async () => {
  const c = await db();
  const hassan = (await listUsers(asClient(c), { search: 'Hassan Ali' })).items[0];
  assert.ok(hassan);
  // The Build Prompt 04 resolver, not a second one written here.
  const line = organisationLine({
    level: hassan.assignmentLevel ?? 'GROUP',
    jobTitle: hassan.jobTitle,
    department: hassan.department,
    countryId: null,
    countryName: hassan.countryName,
    affiliateId: null,
    affiliateName: hassan.affiliateName,
    businessUnitId: null,
    businessUnitName: hassan.businessUnitName,
    assignmentId: 'UA-010',
  } as Parameters<typeof organisationLine>[0]);
  assert.equal(line, 'Group');
  assert.ok(!String(line).includes('null'));
  assert.ok(!/,\s*$/.test(String(line)), 'no dangling separator');
  c.close();
});

test('the five external users appear with empty assignment columns and no error', async () => {
  const c = await db();
  const page = await listUsers(asClient(c), {});
  const external = page.items.filter((u) => u.userType === 'EXTERNAL');
  assert.equal(external.length, 5);
  for (const row of external) {
    // Every join out of `users` is a LEFT JOIN. An INNER JOIN would have
    // dropped these five and the directory would be quietly lying.
    assert.equal(row.jobTitle, null);
    assert.equal(row.assignmentLevel, null);
    assert.equal(row.affiliateName, null);
    assert.ok(row.email.length > 0, 'the row still renders');
  }
  c.close();
});

test('a filter narrows without dropping anybody from the unfiltered view', async () => {
  const c = await db();
  const all = await listUsers(asClient(c), {});
  assert.equal(all.total, 15);
  const kenya = await listUsers(asClient(c), { affiliateId: SEED.affKenya });
  assert.ok(kenya.total > 0 && kenya.total < all.total);
  assert.ok(kenya.items.every((u) => u.affiliateName === 'Hass Petroleum Kenya'));
  // Filters combine with AND. Two Kenya Finance Managers, at different levels:
  // Gabriel at AFFILIATE and Zuleika at BUSINESS_UNIT, both carrying AFF-KE.
  const both = await listUsers(asClient(c), {
    affiliateId: SEED.affKenya,
    jobTitleId: SEED.titleFinanceManager,
  });
  assert.deepEqual(both.items.map((u) => u.displayName).sort(), [
    'Gabriel Musembi',
    'Zuleika Omar',
  ]);
  c.close();
});

test('search matches name, email and employee number, in either case', async () => {
  const c = await db();
  for (const term of ['MUSEMBI', 'gabriel.musembi', 'EMP-1002', 'emp-1002']) {
    const page = await listUsers(asClient(c), { search: term });
    assert.equal(page.items.length, 1, `search "${term}" must find exactly Gabriel`);
    assert.equal(page.items[0]?.userId, SEED.gabriel);
  }
  c.close();
});

// ---- creating a user -------------------------------------------------------

test('email is mandatory and its shape is checked before the database', async () => {
  for (const email of ['', 'not-an-email', 'missing@domain']) {
    const r = validateCreateUser({ firstName: 'A', lastName: 'B', email });
    assert.ok(!r.ok, `${email} must be refused`);
    assert.equal(r.errors[0]?.field, 'email');
  }
});

test('a new user is created as INVITED with a token, and a create is audited', async () => {
  const c = await db();
  const input = valid(
    validateCreateUser({
      firstName: 'Test',
      lastName: 'Person',
      email: 'test.person@hasspetroleum.com',
      employeeNo: 'EMP-9999',
    }),
  );
  const result = await createUser(asClient(c), input, invitation(), CTX);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.user.status, 'INVITED');
  assert.equal(result.value.user.emailVerifiedAt, null);

  const tokens = query(
    c,
    `SELECT * FROM email_verification_tokens WHERE user_id = ?`,
    result.value.user.userId,
  );
  assert.equal(tokens.length, 1, 'a user is never created without an invitation');
  assert.equal(tokens[0]?.status, 'PENDING');
  // Only the hash is stored. The raw token is in the return value alone.
  assert.ok(!String(tokens[0]?.token_hash).includes(result.value.invitationToken));

  const rows = audits(c).filter((r) => r.entity_id === result.value.user.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.event_type, 'USER_CREATED');
  assert.equal(rows[0]?.actor_user_id, SEED.admin);
  c.close();
});

test('a create that asks for ACTIVE is refused, because the CHECK would refuse it', async () => {
  const r = validateCreateUser({
    firstName: 'A',
    lastName: 'B',
    email: 'a.b@hasspetroleum.com',
    status: 'ACTIVE',
  });
  assert.ok(!r.ok);
  assert.equal(r.errors[0]?.field, 'status');
  assert.match(String(r.errors[0]?.message), /verifying their email/);
});

test('a duplicate email is a field message, and case does not make it a new address', async () => {
  const c = await db();
  for (const email of ['gabriel.musembi@hasspetroleum.com', 'GABRIEL.MUSEMBI@HASSPETROLEUM.COM']) {
    const input = valid(validateCreateUser({ firstName: 'X', lastName: 'Y', email }));
    const result = refused(await createUser(asClient(c), input, invitation(), CTX));
    assert.equal(result.kind, 'conflict');
    assert.equal(result.fields[0]?.field, 'email');
    // The message names the holder: "already exists" leaves nowhere to go.
    assert.match(String(result.fields[0]?.message), /Gabriel Musembi/);
  }
  assert.equal(audits(c).length, 0, 'a refusal is not a change');
  c.close();
});

// ---- assignments -----------------------------------------------------------

test('a GROUP assignment stores NULL in all three location columns', async () => {
  const c = await db();
  const input = valid(
    validateAssignment(
      { jobTitleId: SEED.titleGroupCfo, departmentId: SEED.finance, level: 'GROUP' },
      TODAY,
    ),
  );
  assert.equal(input.countryId, null);
  assert.equal(input.affiliateId, null);
  assert.equal(input.businessUnitId, null);

  const result = await createAssignment(asClient(c), SEED.james, input, CTX);
  assert.ok(result.ok, JSON.stringify(result));
  const row = query(
    c,
    `SELECT * FROM user_assignments WHERE assignment_id = ?`,
    result.value.assignmentId,
  )[0];
  assert.equal(row?.country_id, null);
  assert.equal(row?.affiliate_id, null);
  assert.equal(row?.business_unit_id, null);
  c.close();
});

test('a GROUP assignment sent with an affiliate is refused before the database', async () => {
  const r = validateAssignment(
    {
      jobTitleId: SEED.titleGroupCfo,
      departmentId: SEED.finance,
      level: 'GROUP',
      affiliateId: SEED.affKenya,
    },
    TODAY,
  );
  assert.ok(!r.ok, 'the CHECK would refuse it; this says why');
  assert.equal(r.errors[0]?.field, 'affiliateId');
  assert.match(String(r.errors[0]?.message), /carries no location/);
});

test('COUNTRY, AFFILIATE and BUSINESS_UNIT assignments each insert correctly', async () => {
  const c = await db();
  const cases = [
    { level: 'COUNTRY', countryId: SEED.uganda, column: 'country_id', value: SEED.uganda },
    {
      level: 'AFFILIATE',
      affiliateId: SEED.affTanzania,
      column: 'affiliate_id',
      value: SEED.affTanzania,
    },
    {
      level: 'BUSINESS_UNIT',
      businessUnitId: SEED.aviation,
      column: 'business_unit_id',
      value: SEED.aviation,
    },
  ] as const;
  for (const one of cases) {
    const input = valid(
      validateAssignment(
        {
          jobTitleId: SEED.titleFinanceManager,
          departmentId: SEED.finance,
          isPrimary: false,
          ...one,
        },
        TODAY,
      ),
    );
    const result = await createAssignment(asClient(c), SEED.james, input, CTX);
    assert.ok(result.ok, `${one.level}: ${JSON.stringify(result)}`);
    const row = query(
      c,
      `SELECT * FROM user_assignments WHERE assignment_id = ?`,
      result.value.assignmentId,
    )[0];
    assert.equal(row?.[one.column], one.value);
  }
  c.close();
});

test('a level sent without its own location is refused on that field', async () => {
  for (const level of ['COUNTRY', 'AFFILIATE', 'BUSINESS_UNIT'] as const) {
    const r = validateAssignment(
      { jobTitleId: SEED.titleFinanceManager, departmentId: SEED.finance, level },
      TODAY,
    );
    assert.ok(!r.ok, `${level} must require its location`);
  }
});

test('two Finance Managers in different affiliates each resolve their own context', async () => {
  const c = await db();
  const gabriel = (await listAssignments(asClient(c), SEED.gabriel)).find((a) => a.current);
  const grace = (await listAssignments(asClient(c), SEED.grace)).find((a) => a.current);
  assert.equal(gabriel?.jobTitle, 'Finance Manager');
  assert.equal(grace?.jobTitle, 'Finance Manager');
  assert.equal(gabriel?.affiliateName, 'Hass Petroleum Kenya');
  assert.equal(grace?.affiliateName, 'Hass Petroleum Uganda');
  assert.notEqual(gabriel?.affiliateId, grace?.affiliateId);
  c.close();
});

test('a user with two overlapping assignments resolves exactly one primary', async () => {
  const c = await db();
  // Gabriel already holds UA-002 as primary. Add a second, also primary.
  const second = valid(
    validateAssignment(
      {
        jobTitleId: SEED.titleCountryManager,
        departmentId: SEED.finance,
        level: 'COUNTRY',
        countryId: SEED.kenya,
        isPrimary: true,
      },
      TODAY,
    ),
  );
  const result = await createAssignment(asClient(c), SEED.gabriel, second, CTX);
  assert.ok(result.ok, JSON.stringify(result));

  const held = await listAssignments(asClient(c), SEED.gabriel);
  assert.equal(held.length, 2, 'the earlier posting is kept, not overwritten');
  const primaries = held.filter((a) => a.current && a.isPrimary);
  assert.equal(primaries.length, 1, 'exactly one current assignment is primary');
  assert.equal(primaries[0]?.assignmentId, result.value.assignmentId);
  // The demoted one is still a live assignment, just not the primary one.
  const demoted = held.find((a) => a.assignmentId === 'UA-002');
  assert.equal(demoted?.isPrimary, false);
  assert.equal(demoted?.active, true);

  // And the directory shows one row for him, not two.
  const page = await listUsers(asClient(c), { search: 'Musembi' });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.jobTitle, 'Country Manager');
  c.close();
});

test('superseding an assignment ends it and leaves the row in place', async () => {
  const c = await db();
  const result = await updateAssignment(
    asClient(c),
    'UA-002',
    { effectiveTo: '2026-09-30', isPrimary: false, active: false },
    CTX,
  );
  assert.ok(result.ok);
  const row = query(c, `SELECT * FROM user_assignments WHERE assignment_id = 'UA-002'`)[0];
  assert.ok(row, 'the row must still exist');
  assert.equal(row.effective_to, '2026-09-30');
  assert.equal(row.active, 0);
  c.close();
});

// ---- editing, email and status --------------------------------------------

test('a seeded user is an ordinary editable user', async () => {
  const c = await db();
  const before = await getUser(asClient(c), SEED.zuleika);
  assert.ok(before);
  const input = valid(
    validateUpdateUser({
      firstName: 'Zuleika',
      lastName: 'Omar',
      displayName: 'Zuleika A. Omar',
      email: before.email,
      employeeNo: before.employeeNo,
      phone: '+254700000999',
      timezone: before.timezone,
      locale: before.locale,
      status: 'ACTIVE',
    }),
  );
  const result = await updateUser(asClient(c), SEED.zuleika, input, invitation('2'), CTX);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.emailChanged, false);
  assert.equal(result.value.user.displayName, 'Zuleika A. Omar');
  assert.equal(result.value.user.status, 'ACTIVE', 'an unchanged email keeps the user active');
  assert.equal(
    result.value.invitationToken,
    null,
    'no token is issued when nothing needs verifying',
  );
  c.close();
});

test('changing an email clears verification and moves the status, in one operation', async () => {
  const c = await db();
  const before = query(
    c,
    `SELECT email, status, email_verified_at FROM users WHERE user_id = ?`,
    SEED.zuleika,
  )[0];
  assert.equal(before?.status, 'ACTIVE');
  assert.ok(before?.email_verified_at);

  const input = valid(
    validateUpdateUser({
      firstName: 'Zuleika',
      lastName: 'Omar',
      displayName: 'Zuleika Omar',
      email: 'zuleika.omar.new@hasspetroleum.com',
      status: 'ACTIVE',
    }),
  );
  const result = await updateUser(asClient(c), SEED.zuleika, input, invitation('3'), CTX);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.emailChanged, true);

  const after = query(
    c,
    `SELECT email, status, email_verified_at FROM users WHERE user_id = ?`,
    SEED.zuleika,
  )[0];
  assert.equal(after?.email, 'zuleika.omar.new@hasspetroleum.com');
  assert.equal(after?.email_verified_at, null, 'verification is cleared');
  assert.equal(after?.status, STATUS_AFTER_EMAIL_CHANGE);
  assert.notEqual(after?.status, 'ACTIVE');

  // A fresh token is issued and any outstanding one is revoked, so a link sent
  // to an address the person no longer controls stops working.
  const tokens = query(
    c,
    `SELECT status FROM email_verification_tokens WHERE user_id = ?`,
    SEED.zuleika,
  );
  assert.equal(tokens.filter((t) => t.status === 'PENDING').length, 1);

  const changed = audits(c).find((r) => r.event_type === 'USER_EMAIL_CHANGED');
  assert.ok(changed, 'the change is audited');
  assert.equal(JSON.parse(String(changed.before_json)).email, 'zuleika.omar@hasspetroleum.com');
  assert.equal(JSON.parse(String(changed.after_json)).email, 'zuleika.omar.new@hasspetroleum.com');
  c.close();
});

test('setting ACTIVE with a null email_verified_at is a field message, not a 500', async () => {
  const c = await db();
  const created = await createUser(
    asClient(c),
    valid(
      validateCreateUser({
        firstName: 'New',
        lastName: 'Joiner',
        email: 'new.joiner@hasspetroleum.com',
      }),
    ),
    invitation('4'),
    CTX,
  );
  assert.ok(created.ok);

  const input = valid(
    validateUpdateUser({
      firstName: 'New',
      lastName: 'Joiner',
      displayName: 'New Joiner',
      email: 'new.joiner@hasspetroleum.com',
      status: 'ACTIVE',
    }),
  );
  const result = refused(
    await updateUser(asClient(c), created.value.user.userId, input, invitation('5'), CTX),
  );
  assert.equal(result.fields[0]?.field, 'status');
  assert.match(String(result.fields[0]?.message), /verified/);
  // And the row is untouched.
  const row = query(c, `SELECT status FROM users WHERE user_id = ?`, created.value.user.userId)[0];
  assert.equal(row?.status, 'INVITED');
  c.close();
});

test('suspending and reactivating are audited as themselves, not as an edit', async () => {
  const c = await db();
  const base = {
    firstName: 'Gabriel',
    lastName: 'Musembi',
    displayName: 'Gabriel Musembi',
    email: 'gabriel.musembi@hasspetroleum.com',
    employeeNo: 'EMP-1002',
  };
  const suspend = await updateUser(
    asClient(c),
    SEED.gabriel,
    valid(validateUpdateUser({ ...base, status: 'SUSPENDED' })),
    invitation('6'),
    CTX,
  );
  assert.ok(suspend.ok, JSON.stringify(suspend));
  const reactivate = await updateUser(
    asClient(c),
    SEED.gabriel,
    valid(validateUpdateUser({ ...base, status: 'ACTIVE' })),
    invitation('7'),
    CTX,
  );
  assert.ok(reactivate.ok, JSON.stringify(reactivate));

  const events = audits(c)
    .filter((r) => r.entity_id === SEED.gabriel)
    .map((r) => String(r.event_type));
  assert.ok(events.includes('USER_SUSPENDED'), 'a suspension is recorded as one');
  assert.ok(events.includes('USER_REACTIVATED'), 'a reactivation is recorded as one');
  c.close();
});

test('a suspended user is no longer ACTIVE, which is what the session guard reads', async () => {
  const c = await db();
  await updateUser(
    asClient(c),
    SEED.gabriel,
    valid(
      validateUpdateUser({
        firstName: 'Gabriel',
        lastName: 'Musembi',
        displayName: 'Gabriel Musembi',
        email: 'gabriel.musembi@hasspetroleum.com',
        status: 'SUSPENDED',
      }),
    ),
    invitation('8'),
    CTX,
  );
  // Build Prompt 03's resolver requires status = 'ACTIVE', so the next request
  // on an existing session stops working. Asserted here as the state change;
  // the HTTP round trip is in usersApi.test.ts.
  const row = query(c, `SELECT status FROM users WHERE user_id = ?`, SEED.gabriel)[0];
  assert.equal(row?.status, 'SUSPENDED');
  c.close();
});

// ---- job titles ------------------------------------------------------------

test('a job title is created and a duplicate name is a field message', async () => {
  const c = await db();
  const created = await createJobTitle(
    asClient(c),
    { titleName: 'Depot Supervisor', departmentId: SEED.finance, description: null, active: true },
    CTX,
  );
  assert.ok(created.ok);
  const duplicate = refused(
    await createJobTitle(
      asClient(c),
      { titleName: 'Finance Manager', departmentId: null, description: null, active: true },
      CTX,
    ),
  );
  assert.equal(duplicate.kind, 'conflict');
  assert.equal(duplicate.fields[0]?.field, 'titleName');
  c.close();
});

// ---- source identities -----------------------------------------------------

test('a source identity maps to an existing user and never creates one', async () => {
  const c = await db();
  const systems = query(c, `SELECT source_system_id FROM source_systems LIMIT 1`);
  const systemId = String(systems[0]?.source_system_id);
  const before = query(c, `SELECT COUNT(*) AS n FROM users`)[0]?.n;

  const input = valid(
    validateSourceIdentity({
      sourceSystemId: systemId,
      userId: SEED.gabriel,
      externalUsername: 'GABRIEL.MUSEMBI.NEW',
    }),
  );
  const result = await mapSourceIdentity(asClient(c), input, CTX);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(query(c, `SELECT COUNT(*) AS n FROM users`)[0]?.n, before, 'no user was created');

  // COLLATE NOCASE: the same name in another case is the same row.
  const clash = refused(
    await mapSourceIdentity(
      asClient(c),
      valid(
        validateSourceIdentity({
          sourceSystemId: systemId,
          userId: SEED.zuleika,
          externalUsername: 'gabriel.musembi.new',
        }),
      ),
      CTX,
    ),
  );
  assert.equal(clash.kind, 'conflict');
  assert.equal(clash.fields[0]?.field, 'externalUsername');
  assert.match(String(clash.fields[0]?.message), /Gabriel Musembi/);
  c.close();
});

test('a mapping to a user who does not exist is refused, not invented', async () => {
  const c = await db();
  const systemId = String(
    query(c, `SELECT source_system_id FROM source_systems LIMIT 1`)[0]?.source_system_id,
  );
  const result = refused(
    await mapSourceIdentity(
      asClient(c),
      valid(
        validateSourceIdentity({
          sourceSystemId: systemId,
          userId: 'USR-DOES-NOT-EXIST',
          externalUsername: 'ghost.account',
        }),
      ),
      CTX,
    ),
  );
  assert.equal(result.fields[0]?.field, 'userId');
  assert.match(String(result.fields[0]?.message), /Create the user first/);
  c.close();
});

// ---- what these reads must never return ------------------------------------

test('nothing in the detail payload carries a hash, token or secret', async () => {
  const c = await db();
  const payload = JSON.stringify({
    directory: (await listUsers(asClient(c), {})).items,
    assignments: await listAssignments(asClient(c), SEED.gabriel),
    roles: await listUserRoles(asClient(c), SEED.gabriel),
    authority: await listWorkflowAuthority(asClient(c), SEED.gabriel),
    security: await getSecurity(asClient(c), SEED.gabriel),
  });
  for (const forbidden of [
    'password_hash',
    'refresh_token_hash',
    'secret_encrypted',
    'token_hash',
    'passwordHash',
  ]) {
    assert.ok(!payload.includes(forbidden), `a payload must not contain ${forbidden}`);
  }
  // Security reports booleans, never values.
  const security = await getSecurity(asClient(c), SEED.gabriel);
  assert.equal(typeof security?.hasCredential, 'boolean');
  assert.equal(typeof security?.mfaEnabled, 'boolean');
  c.close();
});

test('no audit row carries a token, hash or secret', async () => {
  const c = await db();
  const created = await createUser(
    asClient(c),
    valid(
      validateCreateUser({
        firstName: 'Audit',
        lastName: 'Check',
        email: 'audit.check@hasspetroleum.com',
      }),
    ),
    invitation('9'),
    CTX,
  );
  assert.ok(created.ok);
  await updateUser(
    asClient(c),
    created.value.user.userId,
    valid(
      validateUpdateUser({
        firstName: 'Audit',
        lastName: 'Check',
        displayName: 'Audit Check',
        email: 'audit.check.new@hasspetroleum.com',
        status: 'INVITED',
      }),
    ),
    invitation('10'),
    CTX,
  );
  const serialised = JSON.stringify(audits(c));
  for (const forbidden of ['raw-', 'hash-', 'token_hash', 'tokenHash']) {
    assert.ok(!serialised.includes(forbidden), `an audit row must not contain ${forbidden}`);
  }
  c.close();
});

test('a read writes no audit row', async () => {
  const c = await db();
  await listUsers(asClient(c), {});
  await listAssignments(asClient(c), SEED.gabriel);
  await getSecurity(asClient(c), SEED.gabriel);
  await listJobTitles(asClient(c));
  assert.equal(audits(c).length, 0, 'reads are not configuration changes');
  c.close();
});
