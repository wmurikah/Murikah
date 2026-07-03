/**
 * Hostname routing tests. The module under test has no relative imports, so node
 * can strip types and run it directly. These pin the single host branch the
 * worker relies on: how the host is read and classified, how a path maps to the
 * internal /engr route and back, and the decision for each host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestHost,
  isMarketingHost,
  isWwwHost,
  isEngrHost,
  tenantLabel,
  toEnginePath,
  toAppPath,
  isPassthroughAsset,
  isPublicAppPath,
  isEngrApiPath,
  routeDecision,
} from '../../src/lib/engr/routing.ts';

const req = (host: string | null, url = 'https://example.com/login'): Request =>
  new Request(url, host === null ? undefined : { headers: { host } });

test('requestHost reads the Host header, strips the port and lower-cases', () => {
  assert.equal(requestHost(req('engr.murikah.com')), 'engr.murikah.com');
  assert.equal(requestHost(req('ENGR.Murikah.com:8787')), 'engr.murikah.com');
  assert.equal(requestHost(req('murikah.com')), 'murikah.com');
});

test('requestHost falls back to the URL hostname when there is no Host header', () => {
  assert.equal(requestHost(req(null, 'https://engr.localhost/login')), 'engr.localhost');
});

test('host classification is exact and non-overlapping', () => {
  assert.equal(isMarketingHost('murikah.com'), true);
  assert.equal(isMarketingHost('www.murikah.com'), false);
  assert.equal(isMarketingHost('engr.murikah.com'), false);

  assert.equal(isWwwHost('www.murikah.com'), true);
  assert.equal(isWwwHost('murikah.com'), false);

  assert.equal(isEngrHost('engr.murikah.com'), true);
  assert.equal(isEngrHost('acme.engr.murikah.com'), true);
  assert.equal(isEngrHost('engr.localhost'), true);
  assert.equal(isEngrHost('acme.engr.localhost'), true);
  assert.equal(isEngrHost('murikah.com'), false);
  assert.equal(isEngrHost('notengr.murikah.com'), false);
  assert.equal(isEngrHost('engr.murikah.com.evil.example'), false);
});

test('tenantLabel parses a single label and ignores the bare host', () => {
  assert.equal(tenantLabel('acme.engr.murikah.com'), 'acme');
  assert.equal(tenantLabel('acme.engr.localhost'), 'acme');
  assert.equal(tenantLabel('engr.murikah.com'), null);
  assert.equal(tenantLabel('a.b.engr.murikah.com'), null);
});

test('path mapping to and from the /engr route is idempotent', () => {
  assert.equal(toEnginePath('/'), '/engr');
  assert.equal(toEnginePath('/login'), '/engr/login');
  assert.equal(toEnginePath('/engr/login'), '/engr/login');
  assert.equal(toAppPath('/engr'), '/');
  assert.equal(toAppPath('/engr/login'), '/login');
  assert.equal(toAppPath('/login'), '/login');
});

test('isPassthroughAsset spots infra and file paths, not app routes', () => {
  assert.equal(isPassthroughAsset('/_astro/index.abc.css'), true);
  assert.equal(isPassthroughAsset('/favicon.svg'), true);
  assert.equal(isPassthroughAsset('/login'), false);
  assert.equal(isPassthroughAsset('/costs/9f3a2b'), false);
});

test('public app paths cover login and machine endpoints only', () => {
  assert.equal(isPublicAppPath('/login'), true);
  assert.equal(isPublicAppPath('/api/auth/login'), true);
  assert.equal(isPublicAppPath('/api/cron/dispatch'), true);
  assert.equal(isPublicAppPath('/api/webhooks/delivery'), true);
  assert.equal(isPublicAppPath('/'), false);
  assert.equal(isPublicAppPath('/api/auth/logout'), false);
  assert.equal(isEngrApiPath('/api/requests'), true);
  assert.equal(isEngrApiPath('/requests'), false);
});

test('routeDecision: engr host serves the app, rewriting to the /engr route', () => {
  assert.deepEqual(routeDecision('engr.murikah.com', '/', ''), {
    branch: 'app',
    enginePath: '/engr',
  });
  assert.deepEqual(routeDecision('engr.murikah.com', '/login', ''), {
    branch: 'app',
    enginePath: '/engr/login',
  });
  // A marketing path on the engr host maps to a non-existent engr route (404),
  // it must not fall back to the corporate page.
  assert.deepEqual(routeDecision('engr.murikah.com', '/who-we-are', ''), {
    branch: 'app',
    enginePath: '/engr/who-we-are',
  });
  // Static assets are not rewritten.
  assert.deepEqual(routeDecision('engr.murikah.com', '/_astro/x.css', ''), {
    branch: 'app',
    enginePath: '/_astro/x.css',
  });
});

test('routeDecision: www redirects to the apex, preserving path and query', () => {
  assert.deepEqual(routeDecision('www.murikah.com', '/pricing', '?a=1'), {
    branch: 'redirect-www',
    location: 'https://murikah.com/pricing?a=1',
  });
});

test('routeDecision: marketing serves the site but sends /engr to the subdomain', () => {
  assert.deepEqual(routeDecision('murikah.com', '/', ''), { branch: 'marketing' });
  assert.deepEqual(routeDecision('murikah.com', '/who-we-are', ''), { branch: 'marketing' });
  assert.deepEqual(routeDecision('murikah.com', '/engr/login', '?next=x'), {
    branch: 'redirect-engr-path',
    location: 'https://engr.murikah.com/login?next=x',
  });
  assert.deepEqual(routeDecision('murikah.com', '/engr', ''), {
    branch: 'redirect-engr-path',
    location: 'https://engr.murikah.com/',
  });
});

test('routeDecision: any other host is a neutral 404, never corporate content', () => {
  assert.deepEqual(routeDecision('murikah-web.workers.dev', '/', ''), { branch: 'not-found-host' });
  assert.deepEqual(routeDecision('random.example', '/login', ''), { branch: 'not-found-host' });
});
