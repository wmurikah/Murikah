/**
 * The data-driven workflow engine. The module under test has no relative
 * imports, so node can strip types and run it directly. These pin the exact
 * rules the ported audit workflow relies on: a terminal state is frozen, an
 * undefined move is refused, a required role is enforced (with a platform-owner
 * exemption), and a required comment is demanded, in that order of precedence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTransition,
  allowedNextStatuses,
  type TransitionRule,
} from '../../src/lib/grc/workflow/transitionRules.ts';

// A small work-paper-like workflow: DRAFT -> IN_REVIEW -> APPROVED, with a
// reviewer-only approval that needs a comment, and a reject back to DRAFT.
const RULES: TransitionRule[] = [
  { fromStatus: 'DRAFT', toStatus: 'IN_REVIEW', requiredRole: null, requiresComment: false },
  {
    fromStatus: 'IN_REVIEW',
    toStatus: 'APPROVED',
    requiredRole: 'SENIOR_AUDITOR',
    requiresComment: true,
  },
  {
    fromStatus: 'IN_REVIEW',
    toStatus: 'DRAFT',
    requiredRole: 'SENIOR_AUDITOR',
    requiresComment: false,
  },
];
const TERMINAL = ['APPROVED'];

test('a permitted move with no requirements is allowed', () => {
  const out = evaluateTransition(RULES, TERMINAL, {
    from: 'DRAFT',
    to: 'IN_REVIEW',
    roleCode: 'AUDITOR',
  });
  assert.equal(out.ok, true);
});

test('a terminal state cannot change', () => {
  const out = evaluateTransition(RULES, TERMINAL, {
    from: 'APPROVED',
    to: 'DRAFT',
    roleCode: 'SENIOR_AUDITOR',
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'terminal');
});

test('an undefined transition is refused', () => {
  const out = evaluateTransition(RULES, TERMINAL, {
    from: 'DRAFT',
    to: 'APPROVED',
    roleCode: 'SENIOR_AUDITOR',
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'not_allowed');
});

test('a required role is enforced', () => {
  const out = evaluateTransition(RULES, TERMINAL, {
    from: 'IN_REVIEW',
    to: 'APPROVED',
    roleCode: 'AUDITOR',
    comment: 'looks good',
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'role');
});

test('a platform owner is exempt from the required role', () => {
  const out = evaluateTransition(RULES, TERMINAL, {
    from: 'IN_REVIEW',
    to: 'APPROVED',
    roleCode: 'AUDITOR',
    isPlatformOwner: true,
    comment: 'override sign-off',
  });
  assert.equal(out.ok, true);
});

test('a required comment is demanded, and accepted when present', () => {
  const without = evaluateTransition(RULES, TERMINAL, {
    from: 'IN_REVIEW',
    to: 'APPROVED',
    roleCode: 'SENIOR_AUDITOR',
    comment: '   ',
  });
  assert.equal(without.ok, false);
  assert.equal(without.ok === false && without.code, 'comment');

  const withComment = evaluateTransition(RULES, TERMINAL, {
    from: 'IN_REVIEW',
    to: 'APPROVED',
    roleCode: 'SENIOR_AUDITOR',
    comment: 'Tested and signed off.',
  });
  assert.equal(withComment.ok, true);
});

test('allowedNextStatuses lists only the moves the actor may make', () => {
  assert.deepEqual(allowedNextStatuses(RULES, TERMINAL, 'DRAFT', 'AUDITOR'), ['IN_REVIEW']);
  // A junior auditor cannot approve or reject from review (both need the senior role).
  assert.deepEqual(allowedNextStatuses(RULES, TERMINAL, 'IN_REVIEW', 'AUDITOR'), []);
  // The senior auditor sees both onward moves.
  assert.deepEqual(allowedNextStatuses(RULES, TERMINAL, 'IN_REVIEW', 'SENIOR_AUDITOR'), [
    'APPROVED',
    'DRAFT',
  ]);
  // A terminal state offers nothing.
  assert.deepEqual(allowedNextStatuses(RULES, TERMINAL, 'APPROVED', 'SENIOR_AUDITOR'), []);
});
