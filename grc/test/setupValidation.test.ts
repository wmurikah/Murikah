/**
 * Setup form validation. The module under test is a pure leaf, so node strips
 * types and runs it directly. These pin the code normalisation and the shape
 * checks the Setup endpoints rely on before touching the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseCode,
  isValidCode,
  isValidEmail,
  requireText,
  optionalText,
  isValidInitialPassword,
} from '../../src/lib/grc/repos/setupValidation.ts';

test('normaliseCode upper-cases and collapses to underscores', () => {
  assert.equal(normaliseCode('  north region '), 'NORTH_REGION');
  assert.equal(normaliseCode('Ke-01'), 'KE_01');
  assert.equal(normaliseCode('a & b'), 'A_B');
  assert.equal(normaliseCode('__x__'), 'X');
  assert.equal(normaliseCode('a'.repeat(40)).length, 32);
});

test('isValidCode accepts codes and rejects junk', () => {
  assert.equal(isValidCode('KE01'), true);
  assert.equal(isValidCode('NORTH_REGION'), true);
  assert.equal(isValidCode(''), false);
  assert.equal(isValidCode('_LEAD'), false);
  assert.equal(isValidCode('has space'), false);
  assert.equal(isValidCode('lower'), false);
});

test('isValidEmail is pragmatic', () => {
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('wilberforce.murikah@hasspetroleum.com'), true);
  assert.equal(isValidEmail('no-at'), false);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail('a b@c.d'), false);
});

test('requireText enforces presence and a maximum', () => {
  assert.equal(requireText('  hi ', 10), 'hi');
  assert.equal(requireText('', 10), null);
  assert.equal(requireText('   ', 10), null);
  assert.equal(requireText('toolong', 3), null);
  assert.equal(requireText(null, 10), null);
});

test('optionalText trims, nulls empty and caps length', () => {
  assert.equal(optionalText('  x ', 10), 'x');
  assert.equal(optionalText('', 10), null);
  assert.equal(optionalText(null, 10), null);
  assert.equal(optionalText('abcdef', 3), 'abc');
});

test('isValidInitialPassword needs at least eight characters', () => {
  assert.equal(isValidInitialPassword('short'), false);
  assert.equal(isValidInitialPassword('longenough'), true);
});
