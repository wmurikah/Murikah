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
import { ROLES_MANAGE, USERS_MANAGE } from '../../src/lib/cms/permissions.ts';

import * as roles from '../../src/pages/cms/api/admin/roles/index.ts';
import * as roleItem from '../../src/pages/cms/api/admin/roles/[id].ts';
import * as matrix from '../../src/pages/cms/api/admin/roles/[id]/permissions.ts';
import * as userRoles from '../../src/pages/cms/api/admin/users/[id]/roles.ts';
import * as userRoleItem from '../../src/pages/cms/api/admin/user-roles/[id].ts';

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
];

const WRITES: [string, (c: APIContext) => Promise<Response> | Response][] = [
  ['POST /api/admin/roles', (c) => roles.POST(c)],
  ['PATCH /api/admin/roles/{id}', (c) => roleItem.PATCH(c)],
  ['PATCH /api/admin/roles/{id}/permissions', (c) => matrix.PATCH(c)],
  ['POST /api/admin/users/{id}/roles', (c) => userRoles.POST(c)],
  ['PATCH /api/admin/user-roles/{id}', (c) => userRoleItem.PATCH(c)],
];

const VALID_BODY = {
  roleName: 'Credit Manager',
  roleId: 'ROLE-FIN',
  effectiveFrom: '2026-01-01',
  active: true,
  scopes: [{ scopeType: 'GROUP' }],
  permissions: [{ permissionId: 'PERM-001', granted: true }],
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
});

test('an unsupported verb is refused with 405', async () => {
  const response = await roles.ALL(context([ROLES_MANAGE], 'DELETE', {}));
  assert.equal(response.status, 405);
  assert.equal((await errorOf(response)).error.code, 'method_not_allowed');
});
