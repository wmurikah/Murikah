/**
 * The action-plan action catalogue. The module under test has no relative
 * imports, so node can strip types and run it directly. These pin the mapping
 * the executor relies on: the transition-pair keying (so Return for Rework and
 * HOA Reject, both targeting In Progress, differ), the owner vs auditor gating,
 * the evidence requirement, the status sets, and the editable/deletable rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AP_STATUS,
  ACTION_PLAN_ENUM_TYPE,
  actionForTransition,
  isOverdue,
  isEditableByAuditor,
  isDeletable,
  isTerminal,
  BOARD_VISIBLE_SET,
  PENDING_SET,
} from '../../src/lib/grc/workflow/actionPlanActions.ts';

test('the enum type is the action-plan status type', () => {
  assert.equal(ACTION_PLAN_ENUM_TYPE, 'ACTION_PLAN_STATUS');
});

test('mark as implemented is an owner action needing evidence, to Pending Verification', () => {
  const m = actionForTransition(AP_STATUS.IN_PROGRESS, AP_STATUS.PENDING_VERIFICATION);
  assert.equal(m?.ownerAction, true);
  assert.equal(m?.requiresEvidence, true);
  assert.equal(m?.effect, 'implement');
  assert.equal(m?.permission, null);
});

test('the same target from different states differs (return vs HOA reject)', () => {
  const returnForRework = actionForTransition(
    AP_STATUS.PENDING_VERIFICATION,
    AP_STATUS.IN_PROGRESS,
  );
  const hoaReject = actionForTransition(AP_STATUS.VERIFIED, AP_STATUS.IN_PROGRESS);
  assert.equal(returnForRework?.permission, 'ACTION_PLANS.verify');
  assert.equal(returnForRework?.effect, 'auditor_review');
  assert.equal(hoaReject?.permission, 'ACTION_PLANS.close');
  assert.equal(hoaReject?.effect, 'hoa_review');
});

test('verify and close carry their permissions and reviews', () => {
  assert.equal(
    actionForTransition(AP_STATUS.PENDING_VERIFICATION, AP_STATUS.VERIFIED)?.permission,
    'ACTION_PLANS.verify',
  );
  assert.equal(
    actionForTransition(AP_STATUS.VERIFIED, AP_STATUS.CLOSED)?.permission,
    'ACTION_PLANS.close',
  );
  assert.equal(actionForTransition(AP_STATUS.VERIFIED, AP_STATUS.CLOSED)?.effect, 'hoa_review');
});

test('an unknown transition has no action', () => {
  assert.equal(actionForTransition(AP_STATUS.CLOSED, AP_STATUS.PENDING), null);
});

test('overdue counts only past-due, not-done plans', () => {
  assert.equal(isOverdue(AP_STATUS.IN_PROGRESS, 5), true);
  assert.equal(isOverdue(AP_STATUS.IN_PROGRESS, 0), false);
  assert.equal(isOverdue(AP_STATUS.VERIFIED, 5), false);
  assert.equal(isOverdue(AP_STATUS.PENDING_VERIFICATION, 5), false);
});

test('editable, deletable and terminal rules match the source', () => {
  assert.equal(isEditableByAuditor(AP_STATUS.IN_PROGRESS), true);
  assert.equal(isEditableByAuditor(AP_STATUS.VERIFIED), false);
  assert.equal(isEditableByAuditor(AP_STATUS.CLOSED), false);
  assert.equal(isDeletable(AP_STATUS.PENDING), true);
  assert.equal(isDeletable(AP_STATUS.PENDING_VERIFICATION), false);
  assert.equal(isTerminal(AP_STATUS.CLOSED), true);
  assert.equal(isTerminal(AP_STATUS.REJECTED), true);
  assert.equal(isTerminal(AP_STATUS.IN_PROGRESS), false);
});

test('the status sets have the expected members', () => {
  assert.ok(PENDING_SET.includes(AP_STATUS.IN_PROGRESS));
  assert.ok(!PENDING_SET.includes(AP_STATUS.VERIFIED));
  assert.ok(BOARD_VISIBLE_SET.includes(AP_STATUS.CLOSED));
  assert.ok(!BOARD_VISIBLE_SET.includes(AP_STATUS.PENDING));
});
