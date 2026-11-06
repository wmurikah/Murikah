import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBeenReleased, makerMayRelease } from '../src/lib/engr/workflow/releasePolicy.ts';

test('an RFQ maker cannot release their own submission', () => {
  assert.equal(makerMayRelease('maker', 'maker'), false);
  assert.equal(makerMayRelease('maker', 'manager'), true);
  assert.equal(makerMayRelease(null, 'manager'), false);
});

test('contractor visibility starts only after a real release timestamp exists', () => {
  assert.equal(hasBeenReleased(null), false);
  assert.equal(hasBeenReleased(''), false);
  assert.equal(hasBeenReleased('   '), false);
  assert.equal(hasBeenReleased('2026-11-06T12:00:00.000Z'), true);
});
