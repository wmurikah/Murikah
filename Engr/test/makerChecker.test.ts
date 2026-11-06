import { test } from 'node:test';
import assert from 'node:assert/strict';
import { independentActor, scheduleMayActivate } from '../src/lib/engr/workflow/makerChecker.ts';

test('an LPO maker cannot approve their own submitted draft', () => {
  assert.equal(independentActor('maker', 'maker', 'creator'), false);
  assert.equal(independentActor('manager', 'maker', 'maker'), true);
});

test('legacy LPOs fall back to creator for maker/checker', () => {
  assert.equal(independentActor('creator', null, 'creator'), false);
  assert.equal(independentActor('manager', null, 'creator'), true);
});

test('a PM schedule creator cannot activate their own paused draft', () => {
  assert.equal(scheduleMayActivate('engineer', 'engineer'), false);
  assert.equal(scheduleMayActivate('manager', 'engineer'), true);
  assert.equal(scheduleMayActivate('manager', null), true);
});
