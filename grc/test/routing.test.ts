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
  isGrcChangePasswordExempt,
  grcMarketingRedirect,
  isGrcMfaPendingAllowed,
  isGrcMfaEnrolExempt,
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

test('public grc paths cover sign-in and the forgotten-password flow only', () => {
  assert.equal(isGrcPublicPath('/login'), true);
  assert.equal(isGrcPublicPath('/api/auth/login'), true);
  assert.equal(isGrcPublicPath('/forgot-password'), true);
  assert.equal(isGrcPublicPath('/api/auth/forgot-password'), true);
  assert.equal(isGrcPublicPath('/reset-password'), true);
  assert.equal(isGrcPublicPath('/api/auth/reset-password'), true);
  assert.equal(isGrcPublicPath('/'), false);
  assert.equal(isGrcPublicPath('/api/auth/logout'), false);
  assert.equal(isGrcApiPath('/api/org/switch'), true);
  assert.equal(isGrcApiPath('/work-papers'), false);
});

test('a pending MFA session reaches only the step, its endpoint and sign-out', () => {
  assert.equal(isGrcMfaPendingAllowed('/mfa'), true);
  assert.equal(isGrcMfaPendingAllowed('/api/auth/mfa/verify'), true);
  assert.equal(isGrcMfaPendingAllowed('/api/auth/logout'), true);
  assert.equal(isGrcMfaPendingAllowed('/'), false);
  assert.equal(isGrcMfaPendingAllowed('/work-papers'), false);
  assert.equal(isGrcMfaPendingAllowed('/mfa/setup'), false);
});

test('the enrolment lock exempts setup, its endpoints, sign-out and change-password', () => {
  assert.equal(isGrcMfaEnrolExempt('/mfa/setup'), true);
  assert.equal(isGrcMfaEnrolExempt('/api/auth/mfa/enrol'), true);
  assert.equal(isGrcMfaEnrolExempt('/api/auth/mfa/confirm'), true);
  assert.equal(isGrcMfaEnrolExempt('/api/auth/logout'), true);
  assert.equal(isGrcMfaEnrolExempt('/change-password'), true);
  assert.equal(isGrcMfaEnrolExempt('/'), false);
  assert.equal(isGrcMfaEnrolExempt('/work-papers'), false);
});

test('change-password exemption covers only the screen, its endpoint and sign-out', () => {
  assert.equal(isGrcChangePasswordExempt('/change-password'), true);
  assert.equal(isGrcChangePasswordExempt('/api/auth/change-password'), true);
  assert.equal(isGrcChangePasswordExempt('/api/auth/logout'), true);
  assert.equal(isGrcChangePasswordExempt('/'), false);
  assert.equal(isGrcChangePasswordExempt('/work-papers'), false);
  assert.equal(isGrcChangePasswordExempt('/api/auth/login'), false);
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
