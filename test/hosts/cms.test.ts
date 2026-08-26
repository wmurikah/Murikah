/**
 * Hass CMS hostname routing tests. The module under test has no relative imports,
 * so node can strip types and run it directly. These pin the host branch the
 * worker relies on for cms.murikah.com: host classification, the mapping to and
 * from the internal /cms route, asset passthrough, the public paths, the portal
 * split, and the marketing redirect for /cms paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCmsHost,
  toCmsPath,
  toCmsAppPath,
  isCmsPassthroughAsset,
  isCmsPublicPath,
  isCmsApiPath,
  isCmsPortalPath,
  cmsMarketingRedirect,
} from '../../src/lib/hosts/cms.ts';

test('isCmsHost matches the apex, sub-labels and local equivalents only', () => {
  assert.equal(isCmsHost('cms.murikah.com'), true);
  assert.equal(isCmsHost('hass.cms.murikah.com'), true);
  assert.equal(isCmsHost('cms.localhost'), true);
  assert.equal(isCmsHost('hass.cms.localhost'), true);
  assert.equal(isCmsHost('grc.murikah.com'), false);
  assert.equal(isCmsHost('engr.murikah.com'), false);
  assert.equal(isCmsHost('murikah.com'), false);
  assert.equal(isCmsHost('notcms.murikah.com'), false);
  assert.equal(isCmsHost('cms.murikah.com.evil.example'), false);
});

test('path mapping to and from the /cms route is idempotent', () => {
  assert.equal(toCmsPath('/'), '/cms');
  assert.equal(toCmsPath('/login'), '/cms/login');
  assert.equal(toCmsPath('/cms/login'), '/cms/login');
  assert.equal(toCmsAppPath('/cms'), '/');
  assert.equal(toCmsAppPath('/cms/login'), '/login');
  assert.equal(toCmsAppPath('/login'), '/login');
});

test('isCmsPassthroughAsset spots infra and file paths, not app routes', () => {
  assert.equal(isCmsPassthroughAsset('/_astro/index.abc.css'), true);
  assert.equal(isCmsPassthroughAsset('/favicon.svg'), true);
  assert.equal(isCmsPassthroughAsset('/login'), false);
  assert.equal(isCmsPassthroughAsset('/portal/orders'), false);
});

test('public cms paths cover the two sign-ins, the login endpoint and the MFA step', () => {
  assert.equal(isCmsPublicPath('/login'), true);
  assert.equal(isCmsPublicPath('/portal/login'), true);
  assert.equal(isCmsPublicPath('/api/auth/login'), true);
  assert.equal(isCmsPublicPath('/mfa'), true);
  assert.equal(isCmsPublicPath('/'), false);
  assert.equal(isCmsPublicPath('/api/auth/logout'), false);
});

test('api and portal path predicates', () => {
  assert.equal(isCmsApiPath('/api/auth/login'), true);
  assert.equal(isCmsApiPath('/dashboard'), false);
  assert.equal(isCmsPortalPath('/portal'), true);
  assert.equal(isCmsPortalPath('/portal/tickets'), true);
  assert.equal(isCmsPortalPath('/dashboard'), false);
});

test('cmsMarketingRedirect sends a /cms path to the subdomain, else null', () => {
  assert.equal(
    cmsMarketingRedirect('/cms/login', '?next=x'),
    'https://cms.murikah.com/login?next=x',
  );
  assert.equal(cmsMarketingRedirect('/cms', ''), 'https://cms.murikah.com/');
  assert.equal(cmsMarketingRedirect('/who-we-are', ''), null);
  assert.equal(cmsMarketingRedirect('/', ''), null);
});
