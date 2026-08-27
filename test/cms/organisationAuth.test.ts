/**
 * Server-side authorisation on the organisation endpoints, called directly.
 *
 * Hidden UI is not access control. A menu entry that is filtered out stops
 * nobody from posting to the endpoint behind it, so these tests never go near
 * the interface: they invoke the exported route handlers with a request and a
 * principal, which is what curl does.
 *
 * No database is involved and none is needed. The guard runs before the
 * endpoint connects, so a refusal is decided without a single row being read.
 * That is the point: an unauthorised caller must not reach the database at all.
 * If a guard were ever removed, these tests would fail by throwing on the
 * missing connection rather than passing quietly, which is the right direction
 * for that mistake to fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../../src/lib/cms/repos/identity.ts';
import { ORGANISATION_MANAGE, ORGANISATION_VIEW } from '../../src/lib/cms/permissions.ts';

import * as countries from '../../src/pages/cms/api/admin/countries/index.ts';
import * as countryItem from '../../src/pages/cms/api/admin/countries/[id].ts';
import * as affiliates from '../../src/pages/cms/api/admin/affiliates/index.ts';
import * as affiliateItem from '../../src/pages/cms/api/admin/affiliates/[id].ts';
import * as businessUnits from '../../src/pages/cms/api/admin/business-units/index.ts';
import * as businessUnitItem from '../../src/pages/cms/api/admin/business-units/[id].ts';
import * as departments from '../../src/pages/cms/api/admin/departments/index.ts';
import * as departmentItem from '../../src/pages/cms/api/admin/departments/[id].ts';
import * as teams from '../../src/pages/cms/api/admin/teams/index.ts';
import * as teamItem from '../../src/pages/cms/api/admin/teams/[id].ts';
import * as teamMembers from '../../src/pages/cms/api/admin/teams/[id]/members.ts';
import * as teamMemberItem from '../../src/pages/cms/api/admin/team-members/[id].ts';

/** An identity carrying exactly the permission codes a case is about. */
function identity(permissions: string[]): CmsIdentity {
  return {
    userId: 'USR-TEST',
    firstName: 'Test',
    lastName: 'User',
    displayName: 'Test User',
    email: 'test.user@hasspetroleum.com',
    userType: 'INTERNAL',
    locale: 'en-KE',
    timezone: 'Africa/Nairobi',
    assignment: null,
    roles: [],
    scopes: [],
    permissions,
    portalMemberships: [],
  };
}

/**
 * The slice of APIContext the handlers read: locals, params, request and url.
 * A cast at the boundary rather than a mock framework.
 */
function context(
  permissions: string[] | null,
  method: string,
  body?: unknown,
  params: Record<string, string> = { id: 'CTR-KE' },
): APIContext {
  const url = new URL('https://cms.murikah.com/api/admin/countries');
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'HassCMS Test' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const locals =
    permissions === null
      ? {}
      : {
          cms: {
            sessionId: 'ASESS-test',
            user: identity(permissions),
            can: (code: string) => permissions.includes(code),
          },
        };
  return { locals, params, request, url } as unknown as APIContext;
}

const errorOf = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

/**
 * Every route in this phase, paired with the verbs it exposes and the
 * permission each verb requires. The list is the test: a new endpoint that is
 * not added here is an endpoint nobody proved the guard on.
 */
const READS: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['GET /api/admin/countries', (c) => countries.GET(c)],
  ['GET /api/admin/countries/{id}', (c) => countryItem.GET(c)],
  ['GET /api/admin/affiliates', (c) => affiliates.GET(c)],
  ['GET /api/admin/affiliates/{id}', (c) => affiliateItem.GET(c)],
  ['GET /api/admin/business-units', (c) => businessUnits.GET(c)],
  ['GET /api/admin/business-units/{id}', (c) => businessUnitItem.GET(c)],
  ['GET /api/admin/departments', (c) => departments.GET(c)],
  ['GET /api/admin/departments/{id}', (c) => departmentItem.GET(c)],
  ['GET /api/admin/teams', (c) => teams.GET(c)],
  ['GET /api/admin/teams/{id}', (c) => teamItem.GET(c)],
  ['GET /api/admin/teams/{id}/members', (c) => teamMembers.GET(c)],
];

const WRITES: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['POST /api/admin/countries', (c) => countries.POST(c)],
  ['PATCH /api/admin/countries/{id}', (c) => countryItem.PATCH(c)],
  ['POST /api/admin/affiliates', (c) => affiliates.POST(c)],
  ['PATCH /api/admin/affiliates/{id}', (c) => affiliateItem.PATCH(c)],
  ['POST /api/admin/business-units', (c) => businessUnits.POST(c)],
  ['PATCH /api/admin/business-units/{id}', (c) => businessUnitItem.PATCH(c)],
  ['POST /api/admin/departments', (c) => departments.POST(c)],
  ['PATCH /api/admin/departments/{id}', (c) => departmentItem.PATCH(c)],
  ['POST /api/admin/teams', (c) => teams.POST(c)],
  ['PATCH /api/admin/teams/{id}', (c) => teamItem.PATCH(c)],
  ['POST /api/admin/teams/{id}/members', (c) => teamMembers.POST(c)],
  ['PATCH /api/admin/team-members/{id}', (c) => teamMemberItem.PATCH(c)],
];

// A body that would be perfectly valid if the caller were allowed. The refusal
// must not depend on the input being wrong as well.
const VALID_BODY = {
  iso2: 'TZ',
  countryName: 'Tanzania',
  timezone: 'Africa/Dar_es_Salaam',
  currencyCode: 'TZS',
  affiliateCode: 'HTZ',
  affiliateName: 'Hass Petroleum Tanzania',
  countryId: 'CTR-KE',
  businessUnitCode: 'LUB',
  businessUnitName: 'Lubricants',
  departmentName: 'Procurement',
  teamName: 'Tanzania Sales',
  teamType: 'SALES',
  userId: 'USR-ZULE',
  effectiveFrom: '2026-08-27',
  effectiveTo: '2026-09-30',
};

test('every mutating endpoint refuses a principal without MANAGE', async () => {
  for (const [name, call] of WRITES) {
    // VIEW only. This is the Country Manager in the permission script: allowed
    // to read the organisation, not to change it.
    const response = await call(context([ORGANISATION_VIEW], 'POST', VALID_BODY));
    assert.equal(response.status, 403, `${name} must refuse a VIEW-only principal`);
    const body = await errorOf(response);
    assert.equal(body.error.code, 'forbidden', name);
  }
});

test('every mutating endpoint refuses a principal with no organisation permission', async () => {
  for (const [name, call] of WRITES) {
    // ADMIN.USERS.MANAGE is a real permission and is not this one. Reusing a
    // neighbouring ADMIN grant is exactly the shortcut the phase forbids.
    const response = await call(context(['ADMIN.USERS.MANAGE'], 'POST', VALID_BODY));
    assert.equal(response.status, 403, `${name} must refuse an unrelated ADMIN grant`);
  }
});

test('every read endpoint refuses a principal with no organisation permission', async () => {
  for (const [name, call] of READS) {
    const response = await call(context(['ADMIN.USERS.MANAGE', 'SERVICE.CASES.VIEW'], 'GET'));
    assert.equal(response.status, 403, `${name} must refuse`);
    const body = await errorOf(response);
    assert.equal(body.error.code, 'forbidden', name);
  }
});

test('every endpoint refuses an anonymous caller with 401, not 403', async () => {
  for (const [name, call] of [...READS, ...WRITES]) {
    // POST so the writes get a body, and GET tolerates the same call because
    // the guard refuses before the method matters.
    const response = await call(context(null, 'POST', VALID_BODY));
    assert.equal(response.status, 401, `${name} must answer 401 when signed out`);
    const body = await errorOf(response);
    // 401 and 403 are different sentences. A client told 403 when it is merely
    // signed out will not try to sign in, and a user is sent to fix the wrong
    // thing.
    assert.equal(body.error.code, 'unauthorised', name);
  }
});

test('MANAGE alone is enough to read, without VIEW being granted separately', async () => {
  // The two codes are independent rows and a role could hold MANAGE alone. An
  // administrator who can edit a country and cannot list countries would be
  // incoherent, so MANAGE implies VIEW. Proved by the refusal not happening:
  // the handler gets past the guard and fails on the absent database instead.
  for (const [name, call] of READS.slice(0, 2)) {
    const response = await call(context([ORGANISATION_MANAGE], 'GET'));
    assert.notEqual(response.status, 403, `${name} must not refuse a MANAGE holder`);
    assert.notEqual(response.status, 401, name);
  }
});

test('the guard reads permission codes and nothing else about the person', async () => {
  // Same person, same email, same name, same user type. The only thing that
  // changes is the permission list, and it is the only thing that changes the
  // answer. An implementation keyed on an email address or a role id would
  // pass one of these and fail the other.
  const refused = await countries.POST(context([], 'POST', VALID_BODY));
  assert.equal(refused.status, 403);

  const allowed = await countries.POST(context([ORGANISATION_MANAGE], 'POST', VALID_BODY));
  assert.notEqual(allowed.status, 403);
});

test('an unsupported verb is refused with 405 and never reaches the database', async () => {
  const response = await countries.ALL(context([ORGANISATION_MANAGE], 'DELETE'));
  assert.equal(response.status, 405);
  const body = await errorOf(response);
  assert.equal(body.error.code, 'method_not_allowed');
});

test('no endpoint in this phase exports a DELETE handler', async () => {
  const modules: [string, Record<string, unknown>][] = [
    ['countries', countries],
    ['countries/[id]', countryItem],
    ['affiliates', affiliates],
    ['affiliates/[id]', affiliateItem],
    ['business-units', businessUnits],
    ['business-units/[id]', businessUnitItem],
    ['departments', departments],
    ['departments/[id]', departmentItem],
    ['teams', teams],
    ['teams/[id]', teamItem],
    ['teams/[id]/members', teamMembers],
    ['team-members/[id]', teamMemberItem],
  ];
  for (const [name, module] of modules) {
    assert.equal(module.DELETE, undefined, `${name} must not export DELETE`);
    // And each one is server-rendered per request. Without this the guard runs
    // once at build time and the protection becomes a static artefact.
    assert.equal(module.prerender, false, `${name} must set prerender = false`);
  }
});
