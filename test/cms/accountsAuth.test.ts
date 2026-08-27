/**
 * Server-side authorisation on the customer endpoints, called directly.
 *
 * The interface is never involved. These invoke the exported route handlers
 * with a request and a principal, which is what curl does, and the guard
 * refuses before the endpoint connects to anything.
 *
 * Criterion 13: every endpoint refuses a principal without the permission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../../src/lib/cms/repos/identity.ts';
import {
  ACCOUNTS_MANAGE,
  ACCOUNTS_VIEW,
  PORTAL_ACCESS_VIEW,
  ROLES_MANAGE,
} from '../../src/lib/cms/permissions.ts';

import * as accounts from '../../src/pages/cms/api/customers/accounts/index.ts';
import * as accountItem from '../../src/pages/cms/api/customers/accounts/[id].ts';
import * as accountContacts from '../../src/pages/cms/api/customers/accounts/[id]/contacts.ts';
import * as contactItem from '../../src/pages/cms/api/customers/contacts/[id].ts';
import * as duplicateCheck from '../../src/pages/cms/api/customers/accounts/duplicate-check.ts';

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
  const url = new URL('https://cms.murikah.com/api/customers/accounts?q=nyali');
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
  return { locals, params: { id: 'ACC-001' }, request, url } as unknown as APIContext;
}

const errorOf = async (response: Response) =>
  (await response.json()) as { error: { code: string } };

type Handler = (c: APIContext) => Promise<Response> | Response;

const READS: [string, Handler][] = [
  ['GET /api/customers/accounts', (c) => accounts.GET(c)],
  ['GET /api/customers/accounts/{id}', (c) => accountItem.GET(c)],
  ['GET /api/customers/accounts/{id}/contacts', (c) => accountContacts.GET(c)],
];

const WRITES: [string, Handler][] = [
  ['POST /api/customers/accounts', (c) => accounts.POST(c)],
  ['PATCH /api/customers/accounts/{id}', (c) => accountItem.PATCH(c)],
  ['POST /api/customers/accounts/{id}/contacts', (c) => accountContacts.POST(c)],
  ['PATCH /api/customers/contacts/{id}', (c) => contactItem.PATCH(c)],
  ['POST /api/customers/accounts/duplicate-check', (c) => duplicateCheck.POST(c)],
];

const EVERY = [...READS, ...WRITES];
const methodFor = (name: string) => (name.startsWith('GET') ? 'GET' : 'POST');

test('every customer route refuses an anonymous caller with 401', async () => {
  for (const [name, handler] of EVERY) {
    const response = await handler(context(null, methodFor(name)));
    assert.equal(response.status, 401, `${name} answered ${response.status}`);
    assert.equal((await errorOf(response)).error.code, 'unauthorised', name);
  }
});

test('every customer route refuses a signed-in caller holding no customer permission', async () => {
  // A user who administers roles, which is a considerable permission, and holds
  // nothing over customers.
  for (const [name, handler] of EVERY) {
    const response = await handler(context([ROLES_MANAGE], methodFor(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
    assert.equal((await errorOf(response)).error.code, 'forbidden', name);
  }
});

test('VIEW reads but does not write', async () => {
  for (const [name, handler] of READS) {
    const response = await handler(context([ACCOUNTS_VIEW], methodFor(name)));
    assert.notEqual(response.status, 401, name);
    assert.notEqual(response.status, 403, name);
  }
  for (const [name, handler] of WRITES) {
    const response = await handler(context([ACCOUNTS_VIEW], methodFor(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
  }
});

test('MANAGE implies VIEW, so a manager can read as well as write', async () => {
  for (const [name, handler] of EVERY) {
    const response = await handler(context([ACCOUNTS_MANAGE], methodFor(name)));
    assert.notEqual(response.status, 401, name);
    assert.notEqual(response.status, 403, name);
  }
});

test('the duplicate check needs MANAGE, not merely VIEW', async () => {
  // It is a pre-create step and it discloses which customers exist. A reader
  // has no reason to run it, and giving it to VIEW would make it a search
  // endpoint with different filtering from the list.
  assert.equal((await duplicateCheck.POST(context([ACCOUNTS_VIEW]))).status, 403);
  assert.notEqual((await duplicateCheck.POST(context([ACCOUNTS_MANAGE]))).status, 403);
});

test('the portal indicator needs its own permission, and its absence is not a template concern', async () => {
  // The contacts route reads CUSTOMERS.PORTAL_ACCESS.VIEW off the principal and
  // passes it into the query, so a caller without it gets a literal NULL in the
  // column rather than a value the interface then hides. Proved here by the
  // permission surface; the query shape is proved in accounts.test.ts.
  assert.equal(PORTAL_ACCESS_VIEW, 'CUSTOMERS.PORTAL_ACCESS.VIEW');
  const without = await accountContacts.GET(context([ACCOUNTS_VIEW], 'GET'));
  assert.notEqual(without.status, 403);
  const with_ = await accountContacts.GET(context([ACCOUNTS_VIEW, PORTAL_ACCESS_VIEW], 'GET'));
  assert.notEqual(with_.status, 403);
});

test('an unrecognised verb is 405, not a silent success', async () => {
  const routes: [string, Handler][] = [
    ['accounts', (c) => accounts.ALL(c)],
    ['accounts/{id}', (c) => accountItem.ALL(c)],
    ['accounts/{id}/contacts', (c) => accountContacts.ALL(c)],
    ['contacts/{id}', (c) => contactItem.ALL(c)],
    ['accounts/duplicate-check', (c) => duplicateCheck.ALL(c)],
  ];
  for (const [name, handler] of routes) {
    const response = await handler(context([ACCOUNTS_MANAGE], 'DELETE'));
    assert.equal(response.status, 405, `${name} answered ${response.status}`);
  }
});

test('no customer route exports DELETE, and every one renders per request', async () => {
  const modules: [string, Record<string, unknown>][] = [
    ['accounts', accounts],
    ['accounts/{id}', accountItem],
    ['accounts/{id}/contacts', accountContacts],
    ['contacts/{id}', contactItem],
    ['accounts/duplicate-check', duplicateCheck],
  ];
  for (const [name, module] of modules) {
    // An account is referenced by cases, opportunities, orders and activities.
    // Deactivation is `status = 'INACTIVE'`, and a contact deactivates with
    // `active = 0`. Nothing is removed.
    assert.equal('DELETE' in module, false, `${name} exports DELETE`);
    assert.equal(module.prerender, false, `${name} is missing prerender = false`);
  }
});

test('a refused write is refused before its input is read', async () => {
  // A payload validation would reject if it ever reached it. The answer is 403,
  // not 422, which shows the guard runs first.
  const response = await accounts.POST(context([ACCOUNTS_VIEW], 'POST', { accountName: '' }));
  assert.equal(response.status, 403);
});

test('an account posted without a country is 422 with the field named', async () => {
  const response = await accounts.POST(
    context([ACCOUNTS_MANAGE], 'POST', { accountName: 'Nyali Ltd', accountType: 'PROSPECT' }),
  );
  assert.equal(response.status, 422);
  const body = (await response.json()) as {
    error: { code: string; fields?: { field: string }[] };
  };
  assert.equal(body.error.code, 'validation_failed');
  assert.equal(body.error.fields?.[0]?.field, 'countryId');
});
