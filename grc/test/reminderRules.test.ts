/**
 * The reminder schedule rules: how each organisation's configured values become
 * safe windows and weekdays. These matter because a nonsense config value must
 * fall back to the shipped default rather than silencing a reminder (window of
 * zero) or flooding it (window of thousands of days), and the weekly overdue
 * reminder must run on the day each organisation chose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reminderDays,
  parseWeekday,
  overdueRunsToday,
  DEFAULT_STALE_REMINDER_DAYS,
  DUE_SOON_DAYS,
} from '../../src/lib/grc/notify/reminderRules.ts';

test('reminderDays uses the configured value and falls back on nonsense', () => {
  assert.equal(reminderDays('7', 3), 7);
  assert.equal(reminderDays('1', 3), 1);
  assert.equal(reminderDays('365', 3), 365);
  for (const bad of [undefined, null, '', '0', '-2', '9000', 'weekly', '3.9' /* floors */]) {
    const got = reminderDays(bad, 3);
    if (bad === '3.9') assert.equal(got, 3);
    else assert.equal(got, 3, `${String(bad)} must fall back`);
  }
  assert.equal(DEFAULT_STALE_REMINDER_DAYS, 3);
  assert.ok(DUE_SOON_DAYS > 0);
});

test('parseWeekday accepts names in any case and 0-6 numbers', () => {
  assert.equal(parseWeekday('Monday'), 1);
  assert.equal(parseWeekday('monday'), 1);
  assert.equal(parseWeekday('  FRIDAY  '), 5);
  assert.equal(parseWeekday('Sunday'), 0);
  assert.equal(parseWeekday('0'), 0);
  assert.equal(parseWeekday('6'), 6);
  for (const bad of [null, undefined, '', 'Mon', '7', 'someday']) {
    assert.equal(parseWeekday(bad), null, `${String(bad)} must not parse`);
  }
});

test('the overdue reminder runs on the configured day, defaulting to Monday', () => {
  // Tuesday configured: runs Tuesday (2), not Monday.
  assert.equal(overdueRunsToday('Tuesday', 2), true);
  assert.equal(overdueRunsToday('Tuesday', 1), false);
  // Unset or unrecognised: Monday.
  assert.equal(overdueRunsToday(undefined, 1), true);
  assert.equal(overdueRunsToday(undefined, 3), false);
  assert.equal(overdueRunsToday('someday', 1), true);
});
