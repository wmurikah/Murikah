/**
 * The mileage amount is always computed server-side from distance and the rate.
 * The module under test has no relative imports, so node can strip types and run
 * it without the Astro or Cloudflare toolchain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mileageAmountMinor } from '../../src/lib/engr/mileage.ts';

test('amount is distance times rate in minor units', () => {
  // 42 km at KES 50/km (5000 minor) is KES 2,100 (210000 minor).
  assert.equal(mileageAmountMinor(42, 5000), 210000);
});

test('a fractional product is rounded to the nearest minor unit', () => {
  assert.equal(mileageAmountMinor(10.5, 333), 3497); // 3496.5 rounds to 3497
});

test('a zero rate or zero distance yields zero', () => {
  assert.equal(mileageAmountMinor(0, 5000), 0);
  assert.equal(mileageAmountMinor(42, 0), 0);
});

test('negative or non-finite inputs yield zero, never a negative amount', () => {
  assert.equal(mileageAmountMinor(-5, 5000), 0);
  assert.equal(mileageAmountMinor(42, -1), 0);
  assert.equal(mileageAmountMinor(Number.NaN, 5000), 0);
});
