/**
 * Hostname routing tests. The module under test has no relative imports, so node
 * can strip types and run it directly. These pin the decisions the middleware
 * relies on: which hosts are the app, how a root-relative path maps to the
 * internal /engr route and back, which paths are public or assets, and how the
 * old marketing path redirects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEngrHost,
  tenantLabel,
  toEnginePath,
  toAppPath,
  isPassthroughAsset,
  isPublicAppPath,
  isEngrApiPath,
  marketingEngrRedirect,
} from '../../src/lib/engr/routing.ts';

test('isEngrHost matches the subdomain, its sub-labels and the local equivalents', () => {
  assert.equal(isEngrHost('engr.murikah.com'), true);
  assert.equal(isEngrHost('ENGR.MURIKAH.COM'), true);
  assert.equal(isEngrHost('acme.engr.murikah.com'), true);
  assert.equal(isEngrHost('engr.localhost'), true);
  assert.equal(isEngrHost('acme.engr.localhost'), true);
});

test('isEngrHost rejects the marketing host and look-alikes', () => {
  assert.equal(isEngrHost('murikah.com'), false);
  assert.equal(isEngrHost('www.murikah.com'), false);
  assert.equal(isEngrHost('localhost'), false);
  // A look-alike that merely contains the string must not match.
  assert.equal(isEngrHost('engr.murikah.com.evil.example'), false);
  assert.equal(isEngrHost('notengr.murikah.com'), false);
});

test('tenantLabel parses a single label and ignores the bare host', () => {
  assert.equal(tenantLabel('acme.engr.murikah.com'), 'acme');
  assert.equal(tenantLabel('acme.engr.localhost'), 'acme');
  assert.equal(tenantLabel('engr.murikah.com'), null);
  assert.equal(tenantLabel('engr.localhost'), null);
  // Deeper names are not a single tenant label.
  assert.equal(tenantLabel('a.b.engr.murikah.com'), null);
});

test('toEnginePath prefixes app paths and is idempotent', () => {
  assert.equal(toEnginePath('/'), '/engr');
  assert.equal(toEnginePath('/login'), '/engr/login');
  assert.equal(toEnginePath('/api/requests'), '/engr/api/requests');
  assert.equal(toEnginePath('/engr'), '/engr');
  assert.equal(toEnginePath('/engr/login'), '/engr/login');
});

test('toAppPath strips the /engr prefix and is idempotent', () => {
  assert.equal(toAppPath('/engr'), '/');
  assert.equal(toAppPath('/engr/login'), '/login');
  assert.equal(toAppPath('/engr/api/requests'), '/api/requests');
  assert.equal(toAppPath('/login'), '/login');
  assert.equal(toAppPath('/'), '/');
});

test('isPassthroughAsset spots infra and file paths, not app routes', () => {
  assert.equal(isPassthroughAsset('/_astro/index.abc.css'), true);
  assert.equal(isPassthroughAsset('/_image'), true);
  assert.equal(isPassthroughAsset('/favicon.svg'), true);
  assert.equal(isPassthroughAsset('/robots.txt'), true);
  assert.equal(isPassthroughAsset('/login'), false);
  assert.equal(isPassthroughAsset('/costs/9f3a2b'), false);
  assert.equal(isPassthroughAsset('/api/payments'), false);
});

test('isPublicAppPath covers the login and machine paths only', () => {
  assert.equal(isPublicAppPath('/login'), true);
  assert.equal(isPublicAppPath('/api/auth/login'), true);
  assert.equal(isPublicAppPath('/api/cron/dispatch'), true);
  assert.equal(isPublicAppPath('/api/webhooks/delivery'), true);
  assert.equal(isPublicAppPath('/'), false);
  assert.equal(isPublicAppPath('/api/requests'), false);
  assert.equal(isPublicAppPath('/api/auth/logout'), false);
});

test('isEngrApiPath distinguishes API routes', () => {
  assert.equal(isEngrApiPath('/api/requests'), true);
  assert.equal(isEngrApiPath('/api'), true);
  assert.equal(isEngrApiPath('/requests'), false);
  assert.equal(isEngrApiPath('/'), false);
});

test('marketingEngrRedirect moves /engr/* to the subdomain and preserves the query', () => {
  assert.equal(marketingEngrRedirect('/engr', ''), 'https://engr.murikah.com/');
  assert.equal(marketingEngrRedirect('/engr/login', ''), 'https://engr.murikah.com/login');
  assert.equal(
    marketingEngrRedirect('/engr/login', '?next=x'),
    'https://engr.murikah.com/login?next=x',
  );
  assert.equal(
    marketingEngrRedirect('/engr/api/requests', '?a=1&b=2'),
    'https://engr.murikah.com/api/requests?a=1&b=2',
  );
  // Not under /engr: leave the marketing site alone.
  assert.equal(marketingEngrRedirect('/about', ''), null);
  assert.equal(marketingEngrRedirect('/', ''), null);
});
