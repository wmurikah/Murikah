/**
 * GRC hostname routing tests. The module under test has no relative imports, so
 * node can strip types and run it directly. These pin the host branch the worker
 * relies on for grc.murikah.com: host classification, the mapping to and from
 * the internal /grc route, asset passthrough, the public paths, and the
 * marketing redirect for /grc paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGrcHost,
  toGrcPath,
  toGrcAppPath,
  isGrcPassthroughAsset,
  isGrcPublicPath,
  isGrcApiPath,
  grcMarketingRedirect,
} from '../../src/lib/grc/routing.ts';

test('isGrcHost matches the apex, sub-labels and local equivalents only', () => {
  assert.equal(isGrcHost('grc.murikah.com'), true);
  assert.equal(isGrcHost('acme.grc.murikah.com'), true);
  assert.equal(isGrcHost('grc.localhost'), true);
  assert.equal(isGrcHost('acme.grc.localhost'), true);
  assert.equal(isGrcHost('engr.murikah.com'), false);
  assert.equal(isGrcHost('murikah.com'), false);
  assert.equal(isGrcHost('notgrc.murikah.com'), false);
  assert.equal(isGrcHost('grc.murikah.com.evil.example'), false);
});

test('path mapping to and from the /grc route is idempotent', () => {
  assert.equal(toGrcPath('/'), '/grc');
  assert.equal(toGrcPath('/login'), '/grc/login');
  assert.equal(toGrcPath('/grc/login'), '/grc/login');
  assert.equal(toGrcAppPath('/grc'), '/');
  assert.equal(toGrcAppPath('/grc/login'), '/login');
  assert.equal(toGrcAppPath('/login'), '/login');
});

test('isGrcPassthroughAsset spots infra and file paths, not app routes', () => {
  assert.equal(isGrcPassthroughAsset('/_astro/index.abc.css'), true);
  assert.equal(isGrcPassthroughAsset('/favicon.svg'), true);
  assert.equal(isGrcPassthroughAsset('/login'), false);
  assert.equal(isGrcPassthroughAsset('/work-papers/abc123'), false);
});

test('public grc paths cover sign-in only', () => {
  assert.equal(isGrcPublicPath('/login'), true);
  assert.equal(isGrcPublicPath('/api/auth/login'), true);
  assert.equal(isGrcPublicPath('/'), false);
  assert.equal(isGrcPublicPath('/api/auth/logout'), false);
  assert.equal(isGrcApiPath('/api/org/switch'), true);
  assert.equal(isGrcApiPath('/work-papers'), false);
});

test('grcMarketingRedirect sends a /grc path to the subdomain, else null', () => {
  assert.equal(
    grcMarketingRedirect('/grc/login', '?next=x'),
    'https://grc.murikah.com/login?next=x',
  );
  assert.equal(grcMarketingRedirect('/grc', ''), 'https://grc.murikah.com/');
  assert.equal(grcMarketingRedirect('/who-we-are', ''), null);
  assert.equal(grcMarketingRedirect('/', ''), null);
});
