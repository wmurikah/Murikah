/**
 * The organisation endpoints as HTTP, against the built worker.
 *
 * The repository tests in organisation.test.ts prove the SQL and the rules;
 * these prove the parts that only exist as HTTP: the status code a duplicate
 * gets, the shape of the body a field message arrives in, and the fact that a
 * signed-in user without the permission is refused by the endpoint rather than
 * by a hidden menu.
 *
 * The whole product is exercised: the worker routes by host, the middleware
 * resolves the session from the cookie, and the endpoint authorises against the
 * resolved permission codes. Nothing is stubbed but the database, which is an
 * in-process Turso stand-in seeded from the operator's own DDL. Nothing here
 * points at hass-cms.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CmsWorker } from './support/worker.ts';
import { AUTH_SCHEMA_DDL } from './support/schema.ts';
import { hashPassword, PASSWORD_ALGORITHM_PBKDF2 } from '../../src/lib/cms/auth/password.ts';
import { seedOrganisation, ORG_IDS } from './support/orgSeed.ts';
import type { TestClient } from './support/db.ts';

const SECRET = 'organisation-test-secret';
/** Never a real password, and never a literal: generated per run. */
const PASSWORD = process.env.CMS_TEST_PASSWORD ?? `test-only-${crypto.randomUUID()}`;

const ADMIN_EMAIL = 'catherine.mwangi@hasspetroleum.com';
const READER_EMAIL = 'rita.achieng@hasspetroleum.com';
const OUTSIDER_EMAIL = 'otieno.kamau@hasspetroleum.com';

const worker = new CmsWorker();
let booted = false;

const built = existsSync(join(import.meta.dirname, '..', '..', 'dist', 'server', 'wrangler.json'));
const skip = () => !built;

before(async () => {
  if (!built) return;
  await worker.start(AUTH_SCHEMA_DDL, SECRET);
  booted = true;

  // The fixture is written against the TestClient interface; the worker's fake
  // Turso exposes a synchronous node:sqlite handle. One adapter at the seam
  // rather than a second copy of the fixture.
  const adapter = {
    async execute(stmt: { sql: string; args?: unknown[] } | string) {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
      const bound = args.map((a) =>
        a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a,
      );
      if (/^\s*(select|pragma)/i.test(sql)) {
        return {
          rows: worker.db.prepare(sql).all(...(bound as never[])) as never,
          rowsAffected: 0,
        };
      }
      const result = worker.db.prepare(sql).run(...(bound as never[]));
      return { rows: [], rowsAffected: Number(result.changes ?? 0) };
    },
  } as unknown as TestClient;
  await seedOrganisation(adapter);

  // Credentials for the three principals these tests sign in as.
  const hash = await hashPassword(PASSWORD);
  for (const [credentialId, userId] of [
    ['CRED-ADMIN', ORG_IDS.admin],
    ['CRED-READ', ORG_IDS.reader],
    ['CRED-NONE', ORG_IDS.outsider],
  ] as const) {
    worker.db
      .prepare(
        `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm,
           must_change_password, password_changed_at, failed_attempts, locked_until, created_at, updated_at)
         VALUES (?,?,?,?,0,'2026-01-05 08:00:00',0,NULL,'2026-01-05 08:00:00','2026-01-05 08:00:00')`,
      )
      .run(credentialId, userId, hash, PASSWORD_ALGORITHM_PBKDF2);
  }
});

after(async () => {
  if (booted) await worker.stop();
});

const signIn = async (email: string) => {
  worker.clearCookies();
  const response = await worker.call('POST', '/api/auth/login', {
    body: { email, password: PASSWORD },
  });
  assert.equal(response.status, 200, `sign-in for ${email} failed: ${response.body}`);
};

/**
 * A parsed response body.
 *
 * `unknown` values rather than `never`, so a test that reads a field the
 * endpoint does not return fails on the assertion rather than on the type. The
 * shapes are asserted here, not declared.
 */
const body = (response: { body: string }) =>
  JSON.parse(response.body) as Record<string, { length: number } & Record<string, unknown>>;
const errorOf = (response: { body: string }) =>
  (
    JSON.parse(response.body) as {
      error: { code: string; message: string; fields?: { field: string; message: string }[] };
    }
  ).error;

const audits = () =>
  worker.db
    .prepare(`SELECT * FROM audit_events ORDER BY event_at, audit_event_id`)
    .all() as unknown as Record<string, unknown>[];

// ---- authorisation ---------------------------------------------------------

test(
  'a signed-in user with no organisation permission is refused by the endpoint',
  { skip: skip() },
  async () => {
    await signIn(OUTSIDER_EMAIL);

    // Otieno holds ADMIN.USERS.MANAGE and nothing organisational. A neighbouring
    // ADMIN grant is exactly the shortcut this must not accept.
    const read = await worker.call('GET', '/api/admin/countries');
    assert.equal(read.status, 403);
    assert.equal(errorOf(read).code, 'forbidden');

    const write = await worker.call('POST', '/api/admin/countries', {
      body: {
        iso2: 'TZ',
        countryName: 'Tanzania',
        timezone: 'Africa/Dar_es_Salaam',
        currencyCode: 'TZS',
      },
    });
    assert.equal(write.status, 403);
    // And nothing was written.
    assert.equal(worker.db.prepare(`SELECT COUNT(*) AS n FROM countries`).get()?.n, 3);
  },
);

test('a VIEW holder can read and cannot write', { skip: skip() }, async () => {
  await signIn(READER_EMAIL);

  const read = await worker.call('GET', '/api/admin/countries');
  assert.equal(read.status, 200);
  assert.equal(body(read).items.length, 3);

  for (const [method, path] of [
    ['POST', '/api/admin/countries'],
    ['POST', '/api/admin/affiliates'],
    ['POST', '/api/admin/business-units'],
    ['POST', '/api/admin/departments'],
    ['POST', '/api/admin/teams'],
    ['POST', `/api/admin/teams/${ORG_IDS.kenyaSales}/members`],
  ] as const) {
    const response = await worker.call(method, path, { body: { departmentName: 'Anything' } });
    assert.equal(
      response.status,
      403,
      `${method} ${path} must refuse a VIEW-only principal: ${response.body}`,
    );
  }
});

test('an anonymous request is 401 and never a redirect', { skip: skip() }, async () => {
  worker.clearCookies();
  const response = await worker.call('GET', '/api/admin/countries', { cookie: null });
  assert.equal(response.status, 401);
  assert.equal(response.location, undefined, 'an API answers, it does not redirect');
  assert.equal(errorOf(response).code, 'unauthorised');
});

// ---- data behaviour, as responses ------------------------------------------

test('a duplicate ISO2 answers 409 with a field message, not a 500', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);
  const response = await worker.call('POST', '/api/admin/countries', {
    body: {
      iso2: 'KE',
      countryName: 'Kenya Republic',
      timezone: 'Africa/Nairobi',
      currencyCode: 'KES',
    },
  });
  assert.equal(response.status, 409);
  const error = errorOf(response);
  assert.equal(error.code, 'conflict');
  assert.equal(error.fields?.[0]?.field, 'iso2');
});

test('an ISO2 of the wrong length answers 422 on the field', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);
  const response = await worker.call('POST', '/api/admin/countries', {
    body: {
      iso2: 'KEN',
      countryName: 'Kenya Three',
      timezone: 'Africa/Nairobi',
      currencyCode: 'KES',
    },
  });
  assert.equal(response.status, 422);
  assert.equal(errorOf(response).fields?.[0]?.field, 'iso2');
});

test(
  'a duplicate affiliate code is refused and a duplicate name is accepted',
  { skip: skip() },
  async () => {
    await signIn(ADMIN_EMAIL);

    const clash = await worker.call('POST', '/api/admin/affiliates', {
      body: { affiliateCode: 'HKE', affiliateName: 'Anything', countryId: ORG_IDS.uganda },
    });
    assert.equal(clash.status, 409);
    assert.equal(errorOf(clash).fields?.[0]?.field, 'affiliateCode');

    // affiliate_name is not UNIQUE in this schema, and two affiliates trading
    // under one name in two countries is a real arrangement.
    const sameName = await worker.call('POST', '/api/admin/affiliates', {
      body: {
        affiliateCode: 'HTZ',
        affiliateName: 'Hass Petroleum Kenya',
        countryId: ORG_IDS.uganda,
      },
    });
    assert.equal(sameName.status, 201);
    assert.equal(body(sameName).affiliateName, 'Hass Petroleum Kenya');
  },
);

test('a team is created with no manager, and the row shows it', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);
  const response = await worker.call('POST', '/api/admin/teams', {
    body: { teamName: 'Group Procurement', teamType: 'PROCUREMENT' },
  });
  assert.equal(response.status, 201, response.body);
  const created = body(response);
  assert.equal(created.managerUserId, null);
  assert.equal(created.affiliateId, null);

  const row = worker.db
    .prepare(`SELECT manager_user_id, affiliate_id, business_unit_id FROM teams WHERE team_id = ?`)
    .get(String(created.teamId)) as Record<string, unknown>;
  assert.equal(row.manager_user_id, null);
  assert.equal(row.affiliate_id, null);
  assert.equal(row.business_unit_id, null);
});

test('a member is added, removed by end date, and the row stays', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);

  const added = await worker.call('POST', `/api/admin/teams/${ORG_IDS.kenyaSales}/members`, {
    body: { userId: ORG_IDS.member, memberRole: 'Analyst', effectiveFrom: '2026-08-27' },
  });
  assert.equal(added.status, 201, added.body);
  const memberId = String(body(added).teamMemberId);

  const before = worker.db
    .prepare(`SELECT effective_to, active FROM team_members WHERE team_member_id = ?`)
    .get(memberId) as Record<string, unknown>;
  assert.equal(before.effective_to, null);
  assert.equal(before.active, 1);

  const ended = await worker.call('PATCH', `/api/admin/team-members/${memberId}`, {
    body: { effectiveTo: '2026-09-30' },
  });
  assert.equal(ended.status, 200, ended.body);

  const after = worker.db
    .prepare(`SELECT effective_to, active FROM team_members WHERE team_member_id = ?`)
    .get(memberId) as Record<string, unknown>;
  assert.ok(after, 'the row must still exist after removal');
  assert.equal(after.effective_to, '2026-09-30');
  assert.equal(after.active, 0);

  // Absent from the current list, present in the historical one.
  const current = await worker.call('GET', `/api/admin/teams/${ORG_IDS.kenyaSales}/members`);
  assert.equal(body(current).items.length, 0);
  const history = await worker.call(
    'GET',
    `/api/admin/teams/${ORG_IDS.kenyaSales}/members?history=1`,
  );
  assert.equal(body(history).items.length, 1);
});

test(
  're-adding the same person on the same date answers 409, not 500',
  { skip: skip() },
  async () => {
    await signIn(ADMIN_EMAIL);
    const payload = { userId: ORG_IDS.manager, effectiveFrom: '2026-07-01' };

    const first = await worker.call('POST', `/api/admin/teams/${ORG_IDS.groupFinance}/members`, {
      body: payload,
    });
    assert.equal(first.status, 201, first.body);

    const second = await worker.call('POST', `/api/admin/teams/${ORG_IDS.groupFinance}/members`, {
      body: payload,
    });
    assert.equal(second.status, 409);
    assert.equal(errorOf(second).fields?.[0]?.field, 'effectiveFrom');
  },
);

test('no response body carries a hash, token or secret', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);
  const bodies: string[] = [];
  for (const path of [
    '/api/admin/countries',
    '/api/admin/affiliates',
    '/api/admin/business-units',
    '/api/admin/departments',
    '/api/admin/teams',
    `/api/admin/teams/${ORG_IDS.kenyaSales}/members?history=1`,
  ]) {
    const response = await worker.call('GET', path);
    assert.equal(response.status, 200, `${path}: ${response.body}`);
    bodies.push(response.body);
  }
  // The team and member queries join `users`, which holds a password hash.
  for (const forbidden of [
    'password_hash',
    'refresh_token_hash',
    'secret_encrypted',
    'token_hash',
  ]) {
    assert.ok(!bodies.join('').includes(forbidden), `no body may contain ${forbidden}`);
  }
});

test('an organisation response is never cached', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);
  const response = await worker.call('GET', '/api/admin/countries');
  assert.equal(response.headers['cache-control'], 'no-store');
});

// ---- audit -----------------------------------------------------------------

test(
  'create, edit and deactivate each write exactly one audit row; a read writes none',
  { skip: skip() },
  async () => {
    await signIn(ADMIN_EMAIL);
    const created = await worker.call('POST', '/api/admin/departments', {
      body: { departmentName: 'Legal', description: 'Contracts and compliance' },
    });
    assert.equal(created.status, 201, created.body);
    const departmentId = String(body(created).departmentId);

    const edited = await worker.call('PATCH', `/api/admin/departments/${departmentId}`, {
      body: { departmentName: 'Legal and Compliance', description: 'Contracts and compliance' },
    });
    assert.equal(edited.status, 200, edited.body);

    const deactivated = await worker.call('PATCH', `/api/admin/departments/${departmentId}`, {
      body: {
        departmentName: 'Legal and Compliance',
        description: 'Contracts and compliance',
        active: false,
      },
    });
    assert.equal(deactivated.status, 200, deactivated.body);

    // Three reads, which must add nothing.
    await worker.call('GET', '/api/admin/departments');
    await worker.call('GET', `/api/admin/departments/${departmentId}`);
    await worker.call('GET', '/api/admin/teams');

    // Selected by entity rather than by position. `newId` gives an audit row a
    // random hex suffix, so rows written in the same second do not sort after
    // the ones already there and a positional window reads the wrong three.
    const rows = audits().filter((row) => row.entity_id === departmentId);
    assert.equal(rows.length, 3, 'one row per mutation, and none for the reads');
    // Compared as a set, not a sequence. `audit_events` records `event_at` to
    // the second and gives the row a random id, so three writes inside one
    // second have no deterministic order in this schema. That is a property of
    // the operator's table rather than of this code, and it is not something
    // this phase may change; the assertion is written to the guarantee that
    // actually exists.
    assert.deepEqual(rows.map((row) => String(row.action)).sort(), [
      'CREATE',
      'DEACTIVATE',
      'UPDATE',
    ]);
    const byAction = new Map(rows.map((row) => [String(row.action), row]));
    for (const row of rows) {
      assert.equal(row.actor_user_id, ORG_IDS.admin, 'the actor is the signed-in user');
      assert.equal(row.entity_type, 'DEPARTMENT');
      assert.ok(row.ip_address, 'the request address is recorded');
      assert.ok(row.user_agent, 'the user agent is recorded');
    }
    assert.equal(byAction.get('CREATE')?.before_json, null, 'a create has no before state');
    assert.equal(JSON.parse(String(byAction.get('CREATE')?.after_json)).departmentName, 'Legal');
    assert.equal(JSON.parse(String(byAction.get('UPDATE')?.before_json)).departmentName, 'Legal');
    assert.equal(
      JSON.parse(String(byAction.get('UPDATE')?.after_json)).departmentName,
      'Legal and Compliance',
    );
    assert.equal(JSON.parse(String(byAction.get('DEACTIVATE')?.before_json)).active, true);
    assert.equal(JSON.parse(String(byAction.get('DEACTIVATE')?.after_json)).active, false);
  },
);

test('a refused write writes no audit row', { skip: skip() }, async () => {
  await signIn(ADMIN_EMAIL);
  const start = audits().length;
  const response = await worker.call('POST', '/api/admin/countries', {
    body: {
      iso2: 'KE',
      countryName: 'Another Kenya',
      timezone: 'Africa/Nairobi',
      currencyCode: 'KES',
    },
  });
  assert.equal(response.status, 409);
  assert.equal(audits().length, start, 'a refusal is not a change');
});

// ---- the rest of the platform ----------------------------------------------

test(
  'the apex, engr and grc hosts and the CMS sign-in are unaffected',
  { skip: skip() },
  async () => {
    const marketing = await worker.call('GET', '/', { cookie: null, host: 'murikah.com' });
    assert.equal(marketing.status, 200);
    assert.equal(marketing.headers['x-mrk-branch'], 'marketing');

    const engr = await worker.call('GET', '/login', { cookie: null, host: 'engr.murikah.com' });
    assert.equal(engr.status, 200);
    assert.equal(engr.headers['x-mrk-branch'], 'app');

    const grc = await worker.call('GET', '/login', { cookie: null, host: 'grc.murikah.com' });
    assert.equal(grc.status, 200);
    assert.equal(grc.headers['x-mrk-branch'], 'grc-app');

    const cms = await worker.call('GET', '/login', { cookie: null });
    assert.equal(cms.status, 200);
    assert.equal(cms.headers['x-mrk-branch'], 'cms-app');
  },
);

test(
  'the workspace renders for an administrator and refuses everyone else',
  { skip: skip() },
  async () => {
    await signIn(ADMIN_EMAIL);
    // Each row is asserted on the tab that lists it. The workspace renders one
    // tab at a time, so looking for a team on the countries tab would be asking
    // the page to show something it correctly does not.
    const countries = await worker.call('GET', '/app/administration/organisation?tab=countries');
    assert.equal(countries.status, 200);
    assert.match(countries.body, /Dormant Territory/, 'an inactive row is listed, not hidden');

    const affiliates = await worker.call('GET', '/app/administration/organisation?tab=affiliates');
    assert.match(affiliates.body, /Bahari Energy Kenya/);

    const teams = await worker.call('GET', '/app/administration/organisation?tab=teams');
    assert.match(teams.body, /Group Finance/);
    // A Group team has no affiliate, and the page says so in words rather than
    // rendering an empty cell.
    assert.match(teams.body, /Group-wide/);

    // A Country Manager reads it, and is offered no way to change it.
    await signIn(READER_EMAIL);
    const readOnly = await worker.call('GET', '/app/administration/organisation?tab=teams');
    assert.equal(readOnly.status, 200);
    // The attribute form, not the bare token. Astro hoists a page's <script> to
    // the document, so the handler that looks for `[data-cms-create]` ships
    // whether or not the drawer rendered; only a real control carries
    // `data-cms-create="`.
    assert.ok(!readOnly.body.includes('data-cms-create="'), 'no create control for a VIEW holder');
    assert.ok(!readOnly.body.includes('data-cms-edit="'), 'no edit control for a VIEW holder');
    assert.ok(!readOnly.body.includes('cms-org-drawer'), 'no edit drawer for a VIEW holder');
    // Not merely hidden: the drawer's behaviour lives in a component rendered
    // in the same branch, so a reader is not shipped code for a control they
    // do not have.
    assert.ok(!readOnly.body.includes('cms-org-form'), 'no drawer script for a VIEW holder');
    // The teams tab offers a read-only link to the team, which a reader may
    // legitimately follow; the other tabs have nowhere to go, so they say so
    // rather than rendering a control that would be refused.
    assert.match(readOnly.body, /organisation\/teams\//, 'a reader may still open a team');
    const readOnlyCountries = await worker.call(
      'GET',
      '/app/administration/organisation?tab=countries',
    );
    assert.match(
      readOnlyCountries.body,
      /View only/,
      'a row with nowhere to go says so rather than offering a dead control',
    );

    await signIn(OUTSIDER_EMAIL);
    const refused = await worker.call('GET', '/app/administration/organisation?tab=affiliates');
    assert.equal(refused.status, 200, 'a page explains rather than 404ing');
    assert.match(refused.body, /do not have access/);
    assert.ok(
      !refused.body.includes('Bahari Energy Kenya'),
      'no data is rendered without the permission',
    );
  },
);
