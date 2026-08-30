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

/** A fetch stand-in that records the call and returns a scripted response. */
function stubFetch(response: { status: number; body?: unknown; throws?: boolean }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response.throws) throw new TypeError('Failed to fetch');
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test('a successful sign-in maps to success and carries the user type', async () => {
  const stub = stubFetch({
    status: 200,
    body: {
      user: {
        userId: 'USR-CATH',
        displayName: 'Catherine Mwangi',
        email: 'c@h.com',
        userType: 'INTERNAL',
      },
      mustChangePassword: false,
    },
  });
  try {
    const result = await submitCredentials({ email: 'c@h.com', password: 'x' });
    assert.equal(result.status, 'success');
    // The user type decides the destination after sign-in, so it must survive.
    if (result.status === 'success') assert.equal(result.user.userType, 'INTERNAL');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.url, '/api/auth/login');
    assert.equal(stub.calls[0]?.init.method, 'POST');
    // same-origin, so the cookie the server sets is stored by the browser and
    // never read by this code.
    assert.equal(stub.calls[0]?.init.credentials, 'same-origin');
  } finally {
    stub.restore();
  }
});

test('the request carries only the credentials, and no token comes back', async () => {
  const stub = stubFetch({
    status: 200,
    body: { user: { userId: 'U1', userType: 'INTERNAL' }, mustChangePassword: false },
  });
  try {
    const result = await submitCredentials({ email: 'a@b.co', password: 'secret-value' });
    const sent = JSON.parse(String(stub.calls[0]?.init.body));
    assert.deepEqual(Object.keys(sent).sort(), ['email', 'password']);
    // Nothing token-shaped reaches the caller: the session lives in an HttpOnly
    // cookie the browser holds and JavaScript cannot read, so there is nothing
    // for this code to put in localStorage even if it wanted to.
    const blob = JSON.stringify(result).toLowerCase();
    for (const forbidden of ['token', 'cookie', 'hash', 'secret-value']) {
      assert.ok(!blob.includes(forbidden), `the result must not contain ${forbidden}`);
    }
  } finally {
    stub.restore();
  }
});

test('a 401 is the generic failure; 429, 5xx and a dead network are transport errors', async () => {
  for (const [status, expected] of [
    [401, 'invalid_credentials'],
    [429, 'transport_error'],
    [503, 'transport_error'],
    [500, 'transport_error'],
  ] as [number, string][]) {
    const stub = stubFetch({ status });
    try {
      assert.equal((await submitCredentials({ email: 'a@b.co', password: 'x' })).status, expected);
    } finally {
      stub.restore();
    }
  }
  const dead = stubFetch({ status: 0, throws: true });
  try {
    const result = await submitCredentials({ email: 'a@b.co', password: 'x' });
    assert.equal(result.status, 'transport_error');
    // A transport problem may say so: it discloses nothing about any account.
    if (result.status === 'transport_error') assert.match(result.message, /connection/i);
  } finally {
    dead.restore();
  }
});

test('a correct password that must be changed is a distinct state, not a failure', async () => {
  const stub = stubFetch({
    status: 200,
    body: { user: { userId: 'USR-X', userType: 'INTERNAL' }, mustChangePassword: true },
  });
  try {
    assert.equal(
      (await submitCredentials({ email: 'a@b.co', password: 'x' })).status,
      'password_change_required',
    );
  } finally {
    stub.restore();
  }
});

test('a 200 with a malformed body is a transport error, not a silent success', async () => {
  const stub = stubFetch({ status: 200, body: { nonsense: true } });
  try {
    assert.equal(
      (await submitCredentials({ email: 'a@b.co', password: 'x' })).status,
      'transport_error',
    );
  } finally {
    stub.restore();
  }
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
      landing: '/app',
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

test('every navigation entry names a real permission code, or none at all', () => {
  assert.ok(CMS_NAV.length > 0);
  for (const item of CMS_NAV) {
    // One entry (Administration) requires any one of several codes, so the
    // shape is checked over the list rather than over a single string.
    const codes = item.permission === null ? [] : [item.permission].flat();
    for (const code of codes) {
      // The database's own form: MODULE.RESOURCE.ACTION, upper case. The
      // placeholders this model shipped with (`cms.customers.view`) matched no
      // row in `permissions`, so every entry would have been hidden from
      // everybody once the filter was wired.
      assert.match(
        code,
        /^[A-Z][A-Z_]*\.[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/,
        `${item.label} does not name a permission code in MODULE.RESOURCE.ACTION form`,
      );
    }
    assert.ok(item.href.startsWith('/'), `${item.label} href must be root-relative on the host`);
    assert.ok(
      !item.href.startsWith('/cms'),
      `${item.label} must not carry the /cms prefix: the worker has already rewritten the path`,
    );
  }
});

test('exactly one entry is reachable without a permission, and it is the landing page', () => {
  const open = CMS_NAV.filter((item) => item.permission === null);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.href, '/app');
});

test('navigation hrefs are unique', () => {
  const hrefs = CMS_NAV.map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test('activeNavItem marks the section, including a child path', () => {
  assert.equal(activeNavItem('/app')?.label, 'Home');
  assert.equal(activeNavItem('/app/operations/customers')?.label, 'Customers');
  assert.equal(activeNavItem('/app/operations/customers/12345')?.label, 'Customers');
  assert.equal(activeNavItem('/nowhere'), null);
});
