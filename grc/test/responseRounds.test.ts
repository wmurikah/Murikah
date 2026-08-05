/**
 * The auditee response round rules: which status a decision records, how the
 * round moves, the deadline arithmetic and the rounds allowance.
 *
 * These matter because they decide when an auditee is let back in. Accepting
 * must close the round, requesting changes must open exactly one more, and the
 * allowance must stop the cycle looping forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESPONSE_STATUS,
  parseDecision,
  statusForDecision,
  nextRound,
  roundsExhausted,
  configuredNumber,
  responseDeadline,
  deadlineState,
  DEFAULT_MAX_RESPONSE_ROUNDS,
} from '../../src/lib/grc/workflow/responseRounds.ts';

test('only the two real decisions are accepted from a form', () => {
  assert.equal(parseDecision('accept'), 'accept');
  assert.equal(parseDecision('request_changes'), 'request_changes');
  for (const bad of [null, '', 'reject', 'ACCEPT', 'delete']) {
    assert.equal(parseDecision(bad), null, `${String(bad)} must not parse as a decision`);
  }
});

test('a decision records the matching response status', () => {
  assert.equal(statusForDecision('accept'), RESPONSE_STATUS.ACCEPTED);
  assert.equal(statusForDecision('request_changes'), RESPONSE_STATUS.CHANGES_REQUESTED);
});

test('accepting closes the round, requesting changes opens the next', () => {
  assert.equal(nextRound(1, 'accept'), 1);
  assert.equal(nextRound(1, 'request_changes'), 2);
  assert.equal(nextRound(3, 'request_changes'), 4);
  // A missing or nonsense round is treated as the first.
  assert.equal(nextRound(0, 'request_changes'), 2);
  assert.equal(nextRound(Number.NaN, 'accept'), 1);
});

test('the rounds allowance stops the cycle looping', () => {
  assert.equal(roundsExhausted(3, DEFAULT_MAX_RESPONSE_ROUNDS), false);
  assert.equal(roundsExhausted(4, DEFAULT_MAX_RESPONSE_ROUNDS), true);
  // A reviewer asking for changes on the last allowed round is refused.
  assert.equal(roundsExhausted(nextRound(3, 'request_changes'), 3), true);
  assert.equal(roundsExhausted(nextRound(2, 'request_changes'), 3), false);
});

test('a configured number falls back when unset or nonsense', () => {
  assert.equal(configuredNumber('21', 14), 21);
  assert.equal(configuredNumber(undefined, 14), 14);
  assert.equal(configuredNumber('', 14), 14);
  assert.equal(configuredNumber('0', 14), 14);
  assert.equal(configuredNumber('-5', 14), 14);
  assert.equal(configuredNumber('not a number', 14), 14);
});

test('the deadline is the sent date plus the allowance', () => {
  assert.equal(responseDeadline('2026-03-01T00:00:00.000Z', 14), '2026-03-15');
  assert.equal(responseDeadline(null, 14), null);
  assert.equal(responseDeadline('not a date', 14), null);
});

test('deadline state distinguishes overdue, due soon and comfortable', () => {
  const now = Date.parse('2026-03-10T00:00:00.000Z');
  const overdue = deadlineState('2026-03-05', now);
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.daysRemaining, -5);

  const soon = deadlineState('2026-03-11', now);
  assert.equal(soon.overdue, false);
  assert.equal(soon.dueSoon, true);

  const comfortable = deadlineState('2026-03-25', now);
  assert.equal(comfortable.overdue, false);
  assert.equal(comfortable.dueSoon, false);
  assert.equal(comfortable.daysRemaining, 15);

  // No deadline is not an overdue deadline.
  const none = deadlineState(null, now);
  assert.deepEqual(none, { daysRemaining: null, overdue: false, dueSoon: false });
});
