/**
 * Server-side authorisation on the RBAC endpoints, called directly.
 *
 * The interface is never involved. These invoke the exported route handlers
 * with a request and a principal, which is what curl does, and the guard
 * refuses before the endpoint connects to anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../../src/lib/cms/repos/identity.ts';
import {
  ROLES_MANAGE,
  USERS_MANAGE,
  WORKFLOW_ROLES_MANAGE,
} from '../../src/lib/cms/permissions.ts';

import * as roles from '../../src/pages/cms/api/admin/roles/index.ts';
import * as roleItem from '../../src/pages/cms/api/admin/roles/[id].ts';
import * as matrix from '../../src/pages/cms/api/admin/roles/[id]/permissions.ts';
import * as userRoles from '../../src/pages/cms/api/admin/users/[id]/roles.ts';
import * as userRoleItem from '../../src/pages/cms/api/admin/user-roles/[id].ts';
import * as mappings from '../../src/pages/cms/api/admin/job-title-mappings/index.ts';
import * as mappingItem from '../../src/pages/cms/api/admin/job-title-mappings/[id].ts';
import * as jobTitle from '../../src/pages/cms/api/admin/users/[id]/job-title.ts';
import * as applyDefaults from '../../src/pages/cms/api/admin/users/[id]/apply-title-defaults.ts';

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
  const url = new URL('https://cms.murikah.com/api/admin/roles');
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
            can: (c: string) => permissions.includes(c),
          },
        };
  return { locals, params: { id: 'ROLE-ADMIN' }, request, url } as unknown as APIContext;
}

const errorOf = async (r: Response) => (await r.json()) as { error: { code: string } };

const READS: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['GET /api/admin/roles', (c) => roles.GET(c)],
  ['GET /api/admin/roles/{id}', (c) => roleItem.GET(c)],
  ['GET /api/admin/roles/{id}/permissions', (c) => matrix.GET(c)],
  ['GET /api/admin/users/{id}/roles', (c) => userRoles.GET(c)],
  // The job title mapping catalogue is role administration: deciding what
  // access a title suggests belongs with the permission that governs access.
  ['GET /api/admin/job-title-mappings', (c) => mappings.GET(c)],
];

const WRITES: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['POST /api/admin/roles', (c) => roles.POST(c)],
  ['PATCH /api/admin/roles/{id}', (c) => roleItem.PATCH(c)],
  ['PATCH /api/admin/roles/{id}/permissions', (c) => matrix.PATCH(c)],
  ['POST /api/admin/users/{id}/roles', (c) => userRoles.POST(c)],
  ['PATCH /api/admin/user-roles/{id}', (c) => userRoleItem.PATCH(c)],
  ['POST /api/admin/job-title-mappings', (c) => mappings.POST(c)],
  ['PATCH /api/admin/job-title-mappings/{id}', (c) => mappingItem.PATCH(c)],
  ['DELETE /api/admin/job-title-mappings/{id}', (c) => mappingItem.DELETE(c)],
];

const VALID_BODY = {
  roleName: 'Credit Manager',
  roleId: 'ROLE-FIN',
  effectiveFrom: '2026-01-01',
  active: true,
  scopes: [{ scopeType: 'GROUP' }],
  permissions: [{ permissionId: 'PERM-001', granted: true }],
  jobTitleId: 'JT-FM',
  targetId: 'ROLE-FIN',
  kind: 'ACCESS',
};

test('every mutating endpoint refuses a principal without ADMIN.ROLES.MANAGE', async () => {
  for (const [name, call] of WRITES) {
    // ADMIN.USERS.MANAGE is a real permission and is not this one. Reusing a
    // neighbouring ADMIN grant is exactly the shortcut this must not accept.
    const response = await call(context([USERS_MANAGE], 'POST', VALID_BODY));
    assert.equal(response.status, 403, `${name} must refuse: ${await response.clone().text()}`);
    assert.equal((await errorOf(response)).error.code, 'forbidden', name);
  }
});

test('every read endpoint refuses a principal without ADMIN.ROLES.MANAGE', async () => {
  for (const [name, call] of READS) {
    const response = await call(context([USERS_MANAGE, 'SERVICE.CASES.VIEW'], 'GET'));
    assert.equal(response.status, 403, name);
  }
});

test('every endpoint refuses an anonymous caller with 401, not 403', async () => {
  for (const [name, call] of [...READS, ...WRITES]) {
    const response = await call(context(null, 'POST', VALID_BODY));
    assert.equal(response.status, 401, name);
    assert.equal((await errorOf(response)).error.code, 'unauthorised', name);
  }
});

test('the holder of ADMIN.ROLES.MANAGE is not refused', async () => {
  for (const [name, call] of READS.slice(0, 2)) {
    const response = await call(context([ROLES_MANAGE], 'GET'));
    assert.notEqual(response.status, 403, name);
    assert.notEqual(response.status, 401, name);
  }
});

test('a user id in the payload is never read as an authorisation input', async () => {
  // The person a role is assigned to comes from the path. A body naming
  // somebody else changes nothing about who the endpoint acts on, and the
  // acting principal comes from the session either way.
  const response = await userRoles.POST(
    context([ROLES_MANAGE], 'POST', {
      ...VALID_BODY,
      userId: 'USR-SOMEBODY-ELSE',
      actorUserId: 'USR-ADMIN',
    }),
  );
  // It gets past the guard and fails on the absent database, which is the
  // proof: the payload did not decide anything before that point.
  assert.notEqual(response.status, 403);
  assert.notEqual(response.status, 401);
});

test('a job title is user administration, and grants nothing', async () => {
  // ADMIN.USERS.MANAGE reaches it, because organisational position grants no
  // permission, no scope and no approval authority anywhere in this product.
  const allowed = await jobTitle.PUT(context([USERS_MANAGE], 'PUT', { jobTitleId: 'JT-FM' }));
  assert.notEqual(allowed.status, 403, 'a user administrator cannot set a title');
  assert.notEqual(allowed.status, 401);

  // And nothing else does. Holding the role permission alone is not it.
  const refused = await jobTitle.PUT(context([ROLES_MANAGE], 'PUT', { jobTitleId: 'JT-FM' }));
  assert.equal(refused.status, 403);
  assert.equal((await errorOf(refused)).error.code, 'forbidden');
  assert.equal((await jobTitle.PUT(context(null, 'PUT', {}))).status, 401);
});

test('applying title defaults checks each capability against what was actually asked for', async () => {
  const roleLine = {
    jobTitleId: 'JT-FM',
    roles: [{ roleId: 'ROLE-FIN', scopeType: 'AFFILIATE', affiliateId: 'AFF-KE' }],
  };
  const authorityLine = {
    jobTitleId: 'JT-FM',
    authorities: [
      { workflowRoleId: 'WROLE-SO-FIN', scopeType: 'AFFILIATE', affiliateId: 'AFF-KE' },
    ],
  };

  // A user administrator holds neither capability, so both halves refuse.
  assert.equal((await applyDefaults.POST(context([USERS_MANAGE], 'POST', roleLine))).status, 403);
  assert.equal(
    (await applyDefaults.POST(context([USERS_MANAGE], 'POST', authorityLine))).status,
    403,
  );

  // GRANTING ACCESS ROLES DOES NOT MAKE SOMEBODY AN APPROVER. The holder of
  // ADMIN.ROLES.MANAGE gets past the guard on the role half and is refused on
  // the authority half, which is a different permission.
  assert.notEqual(
    (await applyDefaults.POST(context([ROLES_MANAGE], 'POST', roleLine))).status,
    403,
  );
  assert.equal(
    (await applyDefaults.POST(context([ROLES_MANAGE], 'POST', authorityLine))).status,
    403,
  );
  assert.notEqual(
    (await applyDefaults.POST(context([WORKFLOW_ROLES_MANAGE], 'POST', authorityLine))).status,
    403,
  );

  // A request asking for both needs both, and is refused whole.
  assert.equal(
    (await applyDefaults.POST(context([ROLES_MANAGE], 'POST', { ...roleLine, ...authorityLine })))
      .status,
    403,
  );
  assert.equal((await applyDefaults.POST(context(null, 'POST', roleLine))).status, 401);
});

test('applying defaults to your own record is refused before any write', async () => {
  // The identity fixture is USR-TEST, so a request whose path names USR-TEST
  // is the caller acting on themselves — the escalation an administrator could
  // otherwise perform on their own record however the screen is drawn.
  const url = new URL('https://cms.murikah.com/api/admin/users/USR-TEST/apply-title-defaults');
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jobTitleId: 'JT-FM',
      roles: [{ roleId: 'ROLE-FIN', scopeType: 'AFFILIATE', affiliateId: 'AFF-KE' }],
    }),
  });
  const response = await applyDefaults.POST({
    locals: {
      cms: {
        sessionId: 'ASESS-test',
        user: identity([ROLES_MANAGE]),
        can: () => true,
      },
    },
    params: { id: 'USR-TEST' },
    request,
    url,
  } as unknown as APIContext);
  assert.equal(response.status, 422);
  assert.match(await response.text(), /your own access/i);
});

test('no endpoint in this phase exports a DELETE handler', () => {
  const modules: [string, Record<string, unknown>][] = [
    ['roles', roles],
    ['roles/[id]', roleItem],
    ['roles/[id]/permissions', matrix],
    ['users/[id]/roles', userRoles],
    ['user-roles/[id]', userRoleItem],
  ];
  for (const [name, module] of modules) {
    assert.equal(module.DELETE, undefined, `${name} must not export DELETE`);
    assert.equal(module.prerender, false, `${name} must set prerender = false`);
  }
  // The mapping catalogue DOES delete, and safely: removing a default revokes
  // nobody's access, because nobody's access ever came from it.
  assert.equal(typeof mappingItem.DELETE, 'function');
  for (const [name, module] of [
    ['job-title-mappings', mappings],
    ['job-title-mappings/[id]', mappingItem],
    ['users/[id]/job-title', jobTitle],
    ['users/[id]/apply-title-defaults', applyDefaults],
  ] as [string, Record<string, unknown>][]) {
    assert.equal(module.prerender, false, `${name} must set prerender = false`);
  }
});

test('an unsupported verb is refused with 405', async () => {
  const response = await roles.ALL(context([ROLES_MANAGE], 'DELETE', {}));
  assert.equal(response.status, 405);
  assert.equal((await errorOf(response)).error.code, 'method_not_allowed');
});
