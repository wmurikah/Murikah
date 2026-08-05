/**
 * Legal hold coverage. The direction of failure matters most here: a hold is a
 * legal instruction, so a malformed or unreadable filter must block (cover
 * everything) rather than quietly fail open and let held evidence be deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdCovers, holdFilterFor } from '../../src/lib/grc/repos/holdRules.ts';

test('a single-entity hold covers exactly that entity', () => {
  const filter = holdFilterFor('work_paper', 'WP-1');
  assert.equal(holdCovers(filter, 'work_paper', 'WP-1'), true);
  assert.equal(holdCovers(filter, 'work_paper', 'WP-2'), false);
  assert.equal(holdCovers(filter, 'action_plan', 'WP-1'), false);
});

test('a type-wide hold covers every entity of the type', () => {
  const filter = JSON.stringify({ entity_type: 'work_paper' });
  assert.equal(holdCovers(filter, 'work_paper', 'WP-1'), true);
  assert.equal(holdCovers(filter, 'work_paper', 'anything'), true);
  assert.equal(holdCovers(filter, 'action_plan', 'AP-1'), false);
});

test('an empty or blanket filter covers everything', () => {
  for (const filter of ['{}', null, '', '   ']) {
    assert.equal(holdCovers(filter, 'work_paper', 'WP-1'), true, JSON.stringify(filter));
  }
});

test('a malformed filter fails closed and covers everything', () => {
  for (const filter of ['not json', '[1,2]', '"just a string"', '{"entity_id": 7}']) {
    assert.equal(holdCovers(filter, 'work_paper', 'WP-1'), true, filter);
  }
});
