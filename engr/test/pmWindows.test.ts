/**
 * Boundary tests for the preventive-maintenance date logic. Run with:
 *   pnpm test
 *
 * The clock is fixed so the one-month and two-week boundaries are exact. The
 * module under test has no relative imports, so node can strip types and run it
 * without the Astro or Cloudflare toolchain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  addMonths,
  eatDateString,
  fixedClock,
  decidePmActions,
  staleStamps,
  nextDueDate,
} from '../../src/lib/engr/time.ts';

const clear = { notified1mAt: null, notified2wAt: null, allocated: false };

test('EAT date crosses midnight three hours before UTC', () => {
  // 2026-03-01 22:30 UTC is 2026-03-02 01:30 EAT.
  const clock = fixedClock(new Date('2026-03-01T22:30:00Z'));
  assert.equal(eatDateString(clock.now()), '2026-03-02');
});

test('addMonths clamps to the last day of a shorter month', () => {
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
});

test('one-month reminder fires on its boundary, not the day before', () => {
  const due = '2026-06-15';
  const oneMonthBefore = addMonths(due, -1); // 2026-05-15
  assert.equal(decidePmActions(addDays(oneMonthBefore, -1), due, clear).fire1m, false);
  assert.equal(decidePmActions(oneMonthBefore, due, clear).fire1m, true);
});

test('two-week reminder fires on its boundary, not the day before', () => {
  const due = '2026-06-15';
  const twoWeeksBefore = addDays(due, -14); // 2026-06-01
  const beforeWindow = addDays(twoWeeksBefore, -1);
  // A day before the two-week window: 1m has fired, 2w has not.
  assert.equal(decidePmActions(beforeWindow, due, clear).fire2w, false);
  assert.equal(decidePmActions(twoWeeksBefore, due, clear).fire2w, true);
});

test('a set stamp stops the reminder re-firing', () => {
  const due = '2026-06-15';
  const onWindow = addMonths(due, -1);
  const stamped = { notified1mAt: '2026-05-15T03:00:00Z', notified2wAt: null, allocated: false };
  assert.equal(decidePmActions(onWindow, due, stamped).fire1m, false);
});

test('a past due date that was never allocated is missed, and fires no reminder', () => {
  const due = '2026-06-15';
  const decision = decidePmActions(addDays(due, 1), due, clear);
  assert.equal(decision.missed, true);
  assert.equal(decision.fire1m, false);
  assert.equal(decision.fire2w, false);
});

test('an allocated occurrence is never missed', () => {
  const due = '2026-06-15';
  const allocated = { notified1mAt: null, notified2wAt: null, allocated: true };
  assert.equal(decidePmActions(addDays(due, 30), due, allocated).missed, false);
});

test('moving a due date forward marks an already-fired stamp stale', () => {
  // Fired the one-month reminder, then the due date is pushed out by two months.
  const stamped = { notified1mAt: '2026-05-15T03:00:00Z', notified2wAt: null, allocated: false };
  const today = '2026-05-16';
  const newDue = '2026-08-15';
  const { clear1m, clear2w } = staleStamps(today, newDue, stamped);
  assert.equal(clear1m, true); // today is now before the new one-month window
  assert.equal(clear2w, false); // 2w was never set
});

test('frequency rolls the due date forward correctly', () => {
  assert.equal(nextDueDate('2026-06-15', 'WEEKLY', null), '2026-06-22');
  assert.equal(nextDueDate('2026-06-15', 'MONTHLY', null), '2026-07-15');
  assert.equal(nextDueDate('2026-06-15', 'QUARTERLY', null), '2026-09-15');
  assert.equal(nextDueDate('2026-06-15', 'BIANNUAL', null), '2026-12-15');
  assert.equal(nextDueDate('2026-06-15', 'ANNUAL', null), '2027-06-15');
  assert.equal(nextDueDate('2026-06-15', 'CUSTOM_DAYS', 45), '2026-07-30');
});
