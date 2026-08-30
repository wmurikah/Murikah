/**
 * The requirement loop. The module under test has no relative imports, so node
 * can strip types and run it directly. These pin the rule the whole module
 * rests on: the status is derived from what happened, never typed in beside it,
 * so a requirement cannot read "Closed" with an unanswered question in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIREMENT_STATUS,
  REQUIREMENT_STATUS_FILTERS,
  REVIEW_STATUS,
  awaitsAudit,
  awaitsOwner,
  isReviewDecision,
  nextRound,
  openInfoRequest,
  requirementStatus,
  requirementStatusLabel,
  reviewStatusFor,
} from '../../src/lib/grc/workflow/requirementFlow.ts';

test('a requirement nobody has answered is outstanding', () => {
  assert.equal(requirementStatus({ hasSubmission: false }), REQUIREMENT_STATUS.OUTSTANDING);
});

test('the two-round loop, state by state', () => {
  // Provided, not yet read.
  assert.equal(
    requirementStatus({ hasSubmission: true, latestReviewStatus: REVIEW_STATUS.PENDING }),
    REQUIREMENT_STATUS.AWAITING_REVIEW,
  );
  // Read, and sent back: it is the owner's move again.
  assert.equal(
    requirementStatus({ hasSubmission: true, latestReviewStatus: REVIEW_STATUS.MORE_INFO }),
    REQUIREMENT_STATUS.MORE_INFO,
  );
  // Answered again, waiting once more.
  assert.equal(
    requirementStatus({ hasSubmission: true, latestReviewStatus: REVIEW_STATUS.PENDING }),
    REQUIREMENT_STATUS.AWAITING_REVIEW,
  );
  // Accepted.
  assert.equal(
    requirementStatus({
      hasSubmission: true,
      latestReviewStatus: REVIEW_STATUS.ACCEPTED,
      closedAt: '2026-08-11T09:00:00.000Z',
    }),
    REQUIREMENT_STATUS.CLOSED,
  );
});

test('a round with no review yet reads as awaiting review', () => {
  // review_status is null between the insert and the first read of it, and a
  // null must not read as "nothing was provided".
  assert.equal(
    requirementStatus({ hasSubmission: true, latestReviewStatus: null }),
    REQUIREMENT_STATUS.AWAITING_REVIEW,
  );
});

test('closed wins over everything', () => {
  // A closed requirement with a stale pending round must not reopen itself.
  assert.equal(
    requirementStatus({
      closedAt: '2026-08-11T09:00:00.000Z',
      hasSubmission: true,
      latestReviewStatus: REVIEW_STATUS.PENDING,
    }),
    REQUIREMENT_STATUS.CLOSED,
  );
});

test('a requirement received before the loop existed is not reopened', () => {
  // Migration 005 recorded receipt with a date and no rounds. That ask was
  // answered, and it must not reappear on somebody's list years later.
  assert.equal(
    requirementStatus({ hasSubmission: false, receivedDate: '2026-03-01' }),
    REQUIREMENT_STATUS.CLOSED,
  );
});

test('whose move it is', () => {
  assert.equal(awaitsOwner(REQUIREMENT_STATUS.OUTSTANDING), true);
  assert.equal(awaitsOwner(REQUIREMENT_STATUS.MORE_INFO), true);
  assert.equal(awaitsOwner(REQUIREMENT_STATUS.AWAITING_REVIEW), false);
  assert.equal(awaitsAudit(REQUIREMENT_STATUS.AWAITING_REVIEW), true);
  assert.equal(awaitsAudit(REQUIREMENT_STATUS.CLOSED), false);
});

test('rounds count from one and never repeat', () => {
  assert.equal(nextRound(0), 1);
  assert.equal(nextRound(1), 2);
  assert.equal(nextRound(7), 8);
  // A count that arrives as nonsense still yields a first round rather than NaN.
  assert.equal(nextRound(Number.NaN), 1);
  assert.equal(nextRound(-3), 1);
});

test('a decision is one of two, and stores the matching review status', () => {
  assert.equal(isReviewDecision('accept'), true);
  assert.equal(isReviewDecision('more_info'), true);
  assert.equal(isReviewDecision('close_quietly'), false);
  assert.equal(reviewStatusFor('accept'), REVIEW_STATUS.ACCEPTED);
  assert.equal(reviewStatusFor('more_info'), REVIEW_STATUS.MORE_INFO);
});

test('the open question is the one the owner still has to answer', () => {
  assert.equal(
    openInfoRequest({
      reviewStatus: REVIEW_STATUS.MORE_INFO,
      additionalInfoRequest: 'Send the signed copy.',
    }),
    'Send the signed copy.',
  );
  // An accepted round leaves nothing to answer, whatever it once asked.
  assert.equal(
    openInfoRequest({ reviewStatus: REVIEW_STATUS.ACCEPTED, additionalInfoRequest: 'Old ask' }),
    null,
  );
  assert.equal(
    openInfoRequest({ reviewStatus: REVIEW_STATUS.MORE_INFO, additionalInfoRequest: '  ' }),
    null,
  );
  assert.equal(openInfoRequest(null), null);
});

test('the four statuses are labelled, and an older code reads as itself', () => {
  assert.equal(requirementStatusLabel(REQUIREMENT_STATUS.OUTSTANDING), 'Outstanding');
  assert.equal(requirementStatusLabel(REQUIREMENT_STATUS.AWAITING_REVIEW), 'Awaiting review');
  assert.equal(requirementStatusLabel(REQUIREMENT_STATUS.MORE_INFO), 'More info');
  assert.equal(requirementStatusLabel(REQUIREMENT_STATUS.CLOSED), 'Closed');
  // Rows written before this module carry free text; relabelling them as one of
  // the four would claim a state nobody put them in.
  assert.equal(requirementStatusLabel('PENDING'), 'PENDING');
  assert.deepEqual(
    [...REQUIREMENT_STATUS_FILTERS],
    ['OUTSTANDING', 'AWAITING_REVIEW', 'MORE_INFO', 'CLOSED'],
  );
});
