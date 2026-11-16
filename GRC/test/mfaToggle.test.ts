import test from 'node:test';
import assert from 'node:assert/strict';
import { mfaEnabledFromBinding } from '../src/lib/grc/auth/mfaToggle.ts';

test('MFA is enabled unless the runtime binding explicitly says false', () => {
  assert.equal(mfaEnabledFromBinding(undefined), true);
  assert.equal(mfaEnabledFromBinding(''), true);
  assert.equal(mfaEnabledFromBinding('true'), true);
  assert.equal(mfaEnabledFromBinding('off'), true);
  assert.equal(mfaEnabledFromBinding(' FALSE '), false);
});
