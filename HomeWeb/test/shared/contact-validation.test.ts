import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContact } from '../../src/lib/validation.ts';

test('a name and work email suffice without a challenge', () => {
  const result = validateContact({ name: 'Sample Visitor', email: ' VISITOR@EXAMPLE.COM ' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.data?.message, '');
  assert.equal(result.data?.email, 'visitor@example.com');
});
test('short challenges are accepted and long fields are bounded', () => {
  assert.equal(
    validateContact({ name: 'Sample', email: 's@example.com', message: 'Audit' }).data?.message,
    'Audit',
  );
  assert.equal(
    validateContact({ name: 'Sample', email: 's@example.com', message: 'a'.repeat(6000) }).data
      ?.message.length,
    5000,
  );
});
test('name and email remain required', () => {
  assert.deepEqual(
    validateContact({ message: 'A challenge' }).errors.map((error) => error.field),
    ['name', 'email'],
  );
});
test('segment attribution accepts known tags without arbitrary input', () => {
  const base = { name: 'Sample', email: 's@example.com' };
  assert.equal(
    validateContact({ ...base, location: 'home', intent: 'call', segment: 'fintech' }).data?.source,
    'contact:home:call:fintech',
  );
  assert.equal(
    validateContact({ ...base, segment: '<script>', intent: 'https://elsewhere.test' }).data
      ?.source,
    'contact:contact',
  );
});
