import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunDailyMaintenance } from '../src/lib/grc/schedule.ts';

test('daily maintenance shares the 03:00 UTC five-minute cron invocation', () => {
  assert.equal(shouldRunDailyMaintenance(Date.parse('2026-11-16T03:00:00Z')), true);
  assert.equal(shouldRunDailyMaintenance(Date.parse('2026-11-16T02:55:00Z')), false);
  assert.equal(shouldRunDailyMaintenance(Date.parse('2026-11-16T03:05:00Z')), false);
  assert.equal(shouldRunDailyMaintenance(Date.parse('2026-11-17T03:00:00Z')), true);
});
