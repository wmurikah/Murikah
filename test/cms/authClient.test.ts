/**
 * The authentication client, and the navigation model.
 *
 * Both modules under test are pure leaves with no runtime imports, so node
 * strips the types and runs them directly, the same way test/shared and
 * test/hosts do.
 *
 * The point of the auth-client tests is not coverage. It is to make the two
 * claims this phase rests on into assertions that fail loudly if a later change
 * breaks them: sign-in returns not-implemented, and a failed sign-in never says
 * which half of the credential was wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  submitCredentials,
  authResultMessage,
  INVALID_CREDENTIALS_MESSAGE,
  type CmsAuthResult,
} from '../../src/lib/cms/auth/client.ts';
import { CMS_NAV, activeNavItem } from '../../src/lib/cms/nav.ts';

test('submitCredentials returns not_implemented and never a success', async () => {
  const result = await submitCredentials({ email: 'someone@hass.co.ke', password: 'whatever' });
  assert.equal(result.status, 'not_implemented');
});

test('submitCredentials makes no network call', async () => {
  // Replace fetch with a trap. If the client ever reaches the network, this
  // throws and the test fails rather than the call quietly succeeding.
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (() => {
    called = true;
    throw new Error('the auth client must not perform a network call in this phase');
  }) as typeof fetch;
  try {
    await submitCredentials({ email: 'a@b.co', password: 'x' });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false);
});

test('the invalid-credentials message names neither the email nor the password', () => {
  const message = authResultMessage({ status: 'invalid_credentials' });
  assert.equal(message, INVALID_CREDENTIALS_MESSAGE);
  // One neutral sentence: it must not tell a caller which half was wrong, which
  // is what turns a login form into an account enumerator.
  assert.doesNotMatch(
    message ?? '',
    /no such|not found|unknown|incorrect password|wrong password/i,
  );
});

test('every outcome the service can return has a decided message', () => {
  const results: CmsAuthResult[] = [
    {
      status: 'success',
      user: { userId: 'u1', displayName: 'A', email: 'a@b.co', userType: 'INTERNAL' },
    },
    { status: 'invalid_credentials' },
    { status: 'account_locked' },
    { status: 'password_change_required', userId: 'u1' },
    { status: 'mfa_required', challengeId: 'c1', methods: [{ methodType: 'TOTP' }] },
    { status: 'transport_error', message: 'Network unavailable.' },
    { status: 'not_implemented' },
  ];
  // Every arm returns either a string to show or an explicit null meaning "this
  // one is a redirect, not a message". Neither may be undefined.
  for (const result of results) {
    const message = authResultMessage(result);
    assert.notEqual(message, undefined, `${result.status} has no decided message`);
  }
});

test('the navigation model carries a permission key on every entry', () => {
  assert.ok(CMS_NAV.length > 0);
  for (const item of CMS_NAV) {
    assert.match(item.permission, /^cms\.[a-z]+\.[a-z]+$/, `${item.label} has no permission key`);
    assert.ok(item.href.startsWith('/'), `${item.label} href must be root-relative on the host`);
    assert.ok(
      !item.href.startsWith('/cms'),
      `${item.label} must not carry the /cms prefix: the worker has already rewritten the path`,
    );
  }
});

test('navigation hrefs are unique', () => {
  const hrefs = CMS_NAV.map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test('activeNavItem marks the section, including a child path', () => {
  assert.equal(activeNavItem('/')?.label, 'Home');
  assert.equal(activeNavItem('/customers')?.label, 'Customers');
  assert.equal(activeNavItem('/customers/12345')?.label, 'Customers');
  assert.equal(activeNavItem('/nowhere'), null);
});
