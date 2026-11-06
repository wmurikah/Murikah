import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedFormMutation } from '../src/lib/engr/auth/formOrigin.ts';

const target = 'https://engr.murikah.com/api/auth/mfa/enroll/start';

function form(headers: Record<string, string>): Request {
  return new Request(target, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: 'code=123456',
  });
}

test('accepts the MFA form from its own public origin', () => {
  assert.equal(allowedFormMutation(form({ origin: 'https://engr.murikah.com' })), true);
  assert.equal(allowedFormMutation(form({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(allowedFormMutation(form({ referer: 'https://engr.murikah.com/mfa/enroll' })), true);
});

test('rejects cross-origin form submissions and missing origin evidence', () => {
  assert.equal(allowedFormMutation(form({ origin: 'https://evil.example' })), false);
  assert.equal(
    allowedFormMutation(form({ origin: 'https://cms.murikah.com', 'sec-fetch-site': 'same-site' })),
    false,
  );
  assert.equal(allowedFormMutation(form({})), false);
  assert.equal(allowedFormMutation(form({ referer: 'not-a-url' })), false);
  assert.equal(
    allowedFormMutation(
      form({ origin: 'https://engr.murikah.com', 'sec-fetch-site': 'cross-site' }),
    ),
    false,
  );
});

test('matches Astro behavior for safe and non-form requests', () => {
  assert.equal(allowedFormMutation(new Request(target)), true);
  assert.equal(
    allowedFormMutation(
      new Request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ),
    true,
  );
});
