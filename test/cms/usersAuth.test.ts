/**
 * Server-side authorisation on the user administration endpoints, called
 * directly.
 *
 * Hidden UI is not access control. A filtered menu stops nobody from posting to
 * the endpoint behind it, so these tests never go near the interface: they
 * invoke the exported route handlers with a request and a principal, which is
 * what curl does.
 *
 * No database is involved and none is needed. The guard runs before the
 * endpoint connects, so a refusal is decided without a single row being read.
 * If a guard were ever removed, these would fail by throwing on the missing
 * connection rather than passing quietly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../../src/lib/cms/repos/identity.ts';
import { USERS_MANAGE, ORGANISATION_MANAGE } from '../../src/lib/cms/permissions.ts';

import * as users from '../../src/pages/cms/api/admin/users/index.ts';
import * as userItem from '../../src/pages/cms/api/admin/users/[id].ts';
import * as assignments from '../../src/pages/cms/api/admin/users/[id]/assignments.ts';
import * as assignmentItem from '../../src/pages/cms/api/admin/assignments/[id].ts';
import * as jobTitles from '../../src/pages/cms/api/admin/job-titles/index.ts';
import * as jobTitleItem from '../../src/pages/cms/api/admin/job-titles/[id].ts';
import * as sourceIdentities from '../../src/pages/cms/api/admin/source-identities/index.ts';

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

function context(permissions: string[] | null, method = 'POST', body: unknown = {}): APIContext {
  const url = new URL('https://cms.murikah.com/api/admin/users');
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'HassCMS Test' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
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
  return { locals, params: { id: 'USR-GAB' }, request, url } as unknown as APIContext;
}

const errorOf = async (r: Response) => (await r.json()) as { error: { code: string } };

/**
 * Every route in this phase, paired with its verbs. The list is the test: a new
 * endpoint that is not added here is an endpoint nobody proved the guard on.
 */
const READS: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['GET /api/admin/users', (c) => users.GET(c)],
  ['GET /api/admin/users/{id}', (c) => userItem.GET(c)],
  ['GET /api/admin/users/{id}/assignments', (c) => assignments.GET(c)],
  ['GET /api/admin/job-titles', (c) => jobTitles.GET(c)],
  ['GET /api/admin/job-titles/{id}', (c) => jobTitleItem.GET(c)],
  ['GET /api/admin/source-identities', (c) => sourceIdentities.GET(c)],
];

const WRITES: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['POST /api/admin/users', (c) => users.POST(c)],
  ['PATCH /api/admin/users/{id}', (c) => userItem.PATCH(c)],
  ['POST /api/admin/users/{id}/assignments', (c) => assignments.POST(c)],
  ['PATCH /api/admin/assignments/{id}', (c) => assignmentItem.PATCH(c)],
  ['POST /api/admin/job-titles', (c) => jobTitles.POST(c)],
  ['PATCH /api/admin/job-titles/{id}', (c) => jobTitleItem.PATCH(c)],
  ['POST /api/admin/source-identities', (c) => sourceIdentities.POST(c)],
];

/** Valid if the caller were allowed, so a refusal cannot be about the input. */
const VALID_BODY = {
  firstName: 'Test',
  lastName: 'Person',
  email: 'test.person@hasspetroleum.com',
  status: 'INVITED',
  titleName: 'Depot Supervisor',
  jobTitleId: 'JT-FM',
  departmentId: 'DEP-FIN',
  level: 'GROUP',
  sourceSystemId: 'SRC-001',
  userId: 'USR-GAB',
  externalUsername: 'test.account',
  effectiveTo: '2026-12-31',
};

test('every mutating endpoint refuses a principal without ADMIN.USERS.MANAGE', async () => {
  for (const [name, call] of WRITES) {
    // A neighbouring ADMIN grant is exactly the shortcut this must not accept.
    const response = await call(context([ORGANISATION_MANAGE], 'POST', VALID_BODY));
    assert.equal(response.status, 403, `${name} must refuse: ${await response.clone().text()}`);
    assert.equal((await errorOf(response)).error.code, 'forbidden', name);
  }
});

test('every read endpoint refuses a principal without ADMIN.USERS.MANAGE', async () => {
  for (const [name, call] of READS) {
    const response = await call(context([ORGANISATION_MANAGE, 'SERVICE.CASES.VIEW'], 'GET'));
    assert.equal(response.status, 403, name);
  }
});

test('every endpoint refuses an anonymous caller with 401, not 403', async () => {
  for (const [name, call] of [...READS, ...WRITES]) {
    const response = await call(context(null, 'POST', VALID_BODY));
    assert.equal(response.status, 401, `${name} must answer 401 when signed out`);
    // 401 and 403 are different sentences. A client told 403 when it is merely
    // signed out will not try to sign in.
    assert.equal((await errorOf(response)).error.code, 'unauthorised', name);
  }
});

test('the holder of ADMIN.USERS.MANAGE is not refused', async () => {
  for (const [name, call] of READS.slice(0, 2)) {
    const response = await call(context([USERS_MANAGE], 'GET'));
    assert.notEqual(response.status, 403, `${name} must not refuse a holder`);
    assert.notEqual(response.status, 401, name);
  }
});

test('the guard reads permission codes and nothing else about the person', async () => {
  // Same email, same name, same user type. The permission list is the only
  // thing that changes, and it is the only thing that changes the answer.
  const refused = await users.POST(context([], 'POST', VALID_BODY));
  assert.equal(refused.status, 403);
  const allowed = await users.POST(context([USERS_MANAGE], 'POST', VALID_BODY));
  assert.notEqual(allowed.status, 403);
});

test('no endpoint in this phase exports a DELETE handler', () => {
  const modules: [string, Record<string, unknown>][] = [
    ['users', users],
    ['users/[id]', userItem],
    ['users/[id]/assignments', assignments],
    ['assignments/[id]', assignmentItem],
    ['job-titles', jobTitles],
    ['job-titles/[id]', jobTitleItem],
    ['source-identities', sourceIdentities],
  ];
  for (const [name, module] of modules) {
    // A user is suspended, never removed: user_assignments, team_members,
    // login_attempts and audit_events all reference users.
    assert.equal(module.DELETE, undefined, `${name} must not export DELETE`);
    assert.equal(module.prerender, false, `${name} must set prerender = false`);
  }
});

test('an unsupported verb is refused with 405 and never reaches the database', async () => {
  const response = await users.ALL(context([USERS_MANAGE], 'DELETE', {}));
  assert.equal(response.status, 405);
  assert.equal((await errorOf(response)).error.code, 'method_not_allowed');
});
