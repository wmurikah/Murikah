/**
 * Segregation-of-duties control tests. The module under test has no relative
 * imports, so node can strip types and run it directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkApprover,
  checkPayer,
  ALLOW_L3_APPROVER_TO_RECORD_PAYMENT,
} from '../../src/lib/engr/workflow/sod.ts';

test('the submitter cannot approve their own submission', () => {
  const r = checkApprover({ actorId: 'u1', submitterId: 'u1', priorApproverIds: [] });
  assert.equal(r.ok, false);
});

test('a different user may approve level one', () => {
  const r = checkApprover({ actorId: 'u2', submitterId: 'u1', priorApproverIds: [] });
  assert.equal(r.ok, true);
});

test('a level one approver cannot also clear level two', () => {
  const r = checkApprover({ actorId: 'u2', submitterId: 'u1', priorApproverIds: ['u2'] });
  assert.equal(r.ok, false);
});

test('a third, distinct user may clear level two', () => {
  const r = checkApprover({ actorId: 'u3', submitterId: 'u1', priorApproverIds: ['u2'] });
  assert.equal(r.ok, true);
});

test('no user may clear two of three billing levels', () => {
  // Level 3 actor who already cleared level 1 is blocked.
  const r = checkApprover({ actorId: 'u2', submitterId: 'u1', priorApproverIds: ['u2', 'u3'] });
  assert.equal(r.ok, false);
});

test('the payer switch defaults to allowing the level three approver to pay', () => {
  assert.equal(ALLOW_L3_APPROVER_TO_RECORD_PAYMENT, true);
  const r = checkPayer({ actorId: 'u3', l3ApproverId: 'u3' });
  assert.equal(r.ok, true);
});
