/**
 * Server-side authorisation on the product catalogue endpoints, called
 * directly.
 *
 * The interface is never involved. These invoke the exported route handlers
 * with a request and a principal, which is what curl does, and the guard
 * refuses before the endpoint connects to anything.
 *
 * The catalogue is read by every module in this product, so a caller who could
 * write it could change what an approval authority rule restricts, what a sales
 * order may contain and what SLA reporting groups by. One permission guards all
 * of it, on every verb including the reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../../src/lib/cms/repos/identity.ts';
import {
  PRODUCT_CATALOGUE_MANAGE,
  ROLES_MANAGE,
  WORKFLOWS_MANAGE,
} from '../../src/lib/cms/permissions.ts';

import * as groups from '../../src/pages/cms/api/admin/product-groups/index.ts';
import * as groupItem from '../../src/pages/cms/api/admin/product-groups/[id].ts';
import * as categories from '../../src/pages/cms/api/admin/product-categories/index.ts';
import * as categoryItem from '../../src/pages/cms/api/admin/product-categories/[id].ts';
import * as products from '../../src/pages/cms/api/admin/products/index.ts';
import * as productItem from '../../src/pages/cms/api/admin/products/[id].ts';
import * as hierarchy from '../../src/pages/cms/api/admin/catalogue/hierarchy.ts';

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
  const url = new URL('https://cms.murikah.com/api/admin/product-groups?q=ago');
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
  return { locals, params: { id: 'PG-FUEL' }, request, url } as unknown as APIContext;
}

const errorOf = async (response: Response) =>
  (await response.json()) as { error: { code: string } };

type Handler = (c: APIContext) => Promise<Response> | Response;

const READS: [string, Handler][] = [
  ['GET /api/admin/product-groups', (c) => groups.GET(c)],
  ['GET /api/admin/product-groups/{id}', (c) => groupItem.GET(c)],
  ['GET /api/admin/product-categories', (c) => categories.GET(c)],
  ['GET /api/admin/product-categories/{id}', (c) => categoryItem.GET(c)],
  ['GET /api/admin/products', (c) => products.GET(c)],
  ['GET /api/admin/products/{id}', (c) => productItem.GET(c)],
  ['GET /api/admin/catalogue/hierarchy', (c) => hierarchy.GET(c)],
];

const WRITES: [string, Handler][] = [
  ['POST /api/admin/product-groups', (c) => groups.POST(c)],
  ['PATCH /api/admin/product-groups/{id}', (c) => groupItem.PATCH(c)],
  ['POST /api/admin/product-categories', (c) => categories.POST(c)],
  ['PATCH /api/admin/product-categories/{id}', (c) => categoryItem.PATCH(c)],
  ['POST /api/admin/products', (c) => products.POST(c)],
  ['PATCH /api/admin/products/{id}', (c) => productItem.PATCH(c)],
];

const EVERY = [...READS, ...WRITES];
const methodFor = (name: string) => (name.startsWith('GET') ? 'GET' : 'POST');

test('every catalogue route refuses an anonymous caller with 401', async () => {
  for (const [name, handler] of EVERY) {
    const response = await handler(context(null, methodFor(name)));
    assert.equal(response.status, 401, `${name} answered ${response.status}`);
    assert.equal((await errorOf(response)).error.code, 'unauthorised', name);
  }
});

test('every catalogue route refuses a signed-in caller without ADMIN.PRODUCT_CATALOG.MANAGE', async () => {
  // A user holding two other real administration permissions. Holding some
  // administration is not holding this administration, and the catalogue is
  // what an authority rule restricts by, so the separation matters.
  for (const [name, handler] of EVERY) {
    const response = await handler(context([ROLES_MANAGE, WORKFLOWS_MANAGE], methodFor(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
    assert.equal((await errorOf(response)).error.code, 'forbidden', name);
  }
});

test('the reads are guarded too, not only the writes', async () => {
  // Stated separately because it is the one an implementation forgets: a read
  // that returned rows to an unauthorised caller would leak the whole
  // catalogue, which is commercial information about what this business sells.
  for (const [name, handler] of READS) {
    const response = await handler(context([], methodFor(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
  }
});

test('the permission gets a caller past the guard on every route', async () => {
  for (const [name, handler] of EVERY) {
    const response = await handler(context([PRODUCT_CATALOGUE_MANAGE], methodFor(name)));
    // Past the guard. Without a database it is 503 or a validation refusal, and
    // neither is 401 or 403, which is the whole claim.
    assert.notEqual(response.status, 401, name);
    assert.notEqual(response.status, 403, name);
  }
});

test('an unrecognised verb is 405, not a silent success', async () => {
  const routes: [string, Handler][] = [
    ['product-groups', (c) => groups.ALL(c)],
    ['product-groups/{id}', (c) => groupItem.ALL(c)],
    ['product-categories', (c) => categories.ALL(c)],
    ['product-categories/{id}', (c) => categoryItem.ALL(c)],
    ['products', (c) => products.ALL(c)],
    ['products/{id}', (c) => productItem.ALL(c)],
    ['catalogue/hierarchy', (c) => hierarchy.ALL(c)],
  ];
  for (const [name, handler] of routes) {
    const response = await handler(context([PRODUCT_CATALOGUE_MANAGE], 'DELETE'));
    assert.equal(response.status, 405, `${name} answered ${response.status}`);
  }
});

test('no catalogue route exports DELETE, and every one renders per request', async () => {
  const modules: [string, Record<string, unknown>][] = [
    ['product-groups', groups],
    ['product-groups/{id}', groupItem],
    ['product-categories', categories],
    ['product-categories/{id}', categoryItem],
    ['products', products],
    ['products/{id}', productItem],
    ['catalogue/hierarchy', hierarchy],
  ];
  for (const [name, module] of modules) {
    // Deactivation is `active = 0`, and ON DELETE RESTRICT would refuse the
    // removal anyway. There is no verb for it.
    assert.equal('DELETE' in module, false, `${name} exports DELETE`);
    assert.equal(module.prerender, false, `${name} is missing prerender = false`);
  }
});

test('a refused write is refused before any input is read', async () => {
  // A payload that would be rejected by validation if it ever reached it. The
  // answer is 403, not 422, which shows the guard runs first.
  const response = await groups.POST(context([ROLES_MANAGE], 'POST', { groupCode: '' }));
  assert.equal(response.status, 403);
});

test('a product posted without a unit of measure is 422 with the field named', async () => {
  const response = await products.POST(
    context([PRODUCT_CATALOGUE_MANAGE], 'POST', {
      productCode: 'NOUOM',
      productName: 'No unit',
      productCategoryId: 'PC-LUBE',
    }),
  );
  assert.equal(response.status, 422);
  const body = (await response.json()) as {
    error: { code: string; fields?: { field: string; message: string }[] };
  };
  assert.equal(body.error.code, 'validation_failed');
  assert.equal(body.error.fields?.[0]?.field, 'unitOfMeasure');
});
