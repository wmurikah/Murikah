/**
 * Build Prompt 39, section 2: the period control.
 *
 * The behaviour under test is the one that stops a working system looking
 * broken. This database holds one extract covering 30 April to 30 May 2026;
 * today is 30 August 2026. The current month is genuinely empty and will stay
 * empty until the next extract lands, so the default must move to the most
 * recent period with data and SAY SO — while a period a person actually chose
 * is honoured even when it is empty, because moving them somewhere else is the
 * page arguing with them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import {
  PRESETS,
  calendarSql,
  choosePeriod,
  drillDays,
  drillMonths,
  drillYears,
  grainFor,
  parsePeriod,
  periodHasData,
  periodHref,
  presetPeriod,
  previousPeriod,
  readCalendar,
  type DataCalendar,
} from '../../src/lib/cms/analytics/period.ts';

const TODAY = new Date('2026-08-30T09:00:00Z');
const preset = (key: Parameters<typeof presetPeriod>[0]) => presetPeriod(key, TODAY)!;

/** The extract's own shape: 30 April to 30 May 2026 and nothing else. */
const EXTRACT: DataCalendar = {
  years: new Set(['2026']),
  months: new Set(['2026-04', '2026-05']),
  days: new Set(['2026-05-01', '2026-05-14', '2026-05-30']),
  earliest: '2026-04-30',
  latest: '2026-05-30',
  total: 412,
};

test('the seven presets each select the right range', () => {
  assert.equal(PRESETS.length, 7);
  assert.deepEqual(
    PRESETS.map((p) => p.key),
    ['this-month', 'last-month', 'this-quarter', 'this-year', 'last-year', 'all', 'custom'],
  );
  assert.deepEqual(
    [preset('this-month').from, preset('this-month').to],
    ['2026-08-01', '2026-08-31'],
  );
  assert.deepEqual(
    [preset('last-month').from, preset('last-month').to],
    ['2026-07-01', '2026-07-31'],
  );
  // August is in Q3: July to September.
  assert.deepEqual(
    [preset('this-quarter').from, preset('this-quarter').to],
    ['2026-07-01', '2026-09-30'],
  );
  assert.equal(preset('this-quarter').label, 'Q3 2026');
  assert.deepEqual(
    [preset('this-year').from, preset('this-year').to],
    ['2026-01-01', '2026-12-31'],
  );
  assert.deepEqual(
    [preset('last-year').from, preset('last-year').to],
    ['2025-01-01', '2025-12-31'],
  );
  assert.deepEqual([preset('all').from, preset('all').to], [null, null]);
});

test('year, month and day drill without typing', () => {
  const year = parsePeriod(new URLSearchParams('period=2026'), TODAY);
  assert.deepEqual(
    [year.from, year.to, year.label, year.level],
    ['2026-01-01', '2026-12-31', '2026', 'YEAR'],
  );
  const month = parsePeriod(new URLSearchParams('period=2026-05'), TODAY);
  assert.deepEqual(
    [month.from, month.to, month.label, month.level],
    ['2026-05-01', '2026-05-31', 'May 2026', 'MONTH'],
  );
  const day = parsePeriod(new URLSearchParams('period=2026-05-14'), TODAY);
  assert.deepEqual(
    [day.from, day.to, day.label, day.level],
    ['2026-05-14', '2026-05-14', '14 May 2026', 'DAY'],
  );
});

test('periods holding no data are marked before selection', () => {
  const years = drillYears(EXTRACT, TODAY);
  assert.ok(years.find((y) => y.key === '2026')?.hasData);
  const months = drillMonths('2026', EXTRACT);
  assert.equal(months.length, 12);
  assert.ok(months.find((m) => m.key === '2026-05')?.hasData);
  assert.equal(months.find((m) => m.key === '2026-08')?.hasData, false);
  assert.equal(months.find((m) => m.key === '2026-01')?.hasData, false);
  const days = drillDays('2026-05', EXTRACT);
  assert.equal(days.length, 31);
  assert.ok(days.find((d) => d.key === '2026-05-14')?.hasData);
  assert.equal(days.find((d) => d.key === '2026-05-02')?.hasData, false);
});

test('the grain is derived from the span, and no trend control remains', () => {
  assert.equal(grainFor('2026-05-14', '2026-05-14'), 'HOUR');
  assert.equal(grainFor('2026-05-01', '2026-05-31'), 'DAY');
  assert.equal(grainFor('2026-07-01', '2026-09-30'), 'DAY');
  assert.equal(grainFor('2026-01-01', '2026-12-31'), 'MONTH');
  assert.equal(grainFor(null, null), 'MONTH');
});

test('an empty default falls back to the most recent period with data and says so', () => {
  const asked = preset('this-month');
  assert.equal(periodHasData(asked, EXTRACT), false);
  const choice = choosePeriod(asked, EXTRACT, TODAY, false);
  assert.equal(choice.period.key, '2026-05');
  assert.equal(choice.fellBackFrom?.label, 'August 2026');
  assert.equal(
    choice.notice,
    'No activity in August 2026. Showing May 2026, the most recent month with data.',
  );
});

test('a period a person chose is honoured even when it is empty', () => {
  const asked = parsePeriod(new URLSearchParams('period=2026-08'), TODAY);
  const choice = choosePeriod(asked, EXTRACT, TODAY, true);
  assert.equal(choice.period.key, '2026-08');
  assert.equal(choice.notice, null);
});

test('the period is in the URL and survives a share and a reload', () => {
  const href = periodHref('/app', parsePeriod(new URLSearchParams('period=2026-05'), TODAY));
  assert.equal(href, '/app?period=2026-05');
  const back = parsePeriod(new URL(`https://example.test${href}`).searchParams, TODAY);
  assert.equal(back.key, '2026-05');
  assert.equal(back.label, 'May 2026');
  // Custom carries its ends, so a shared custom range arrives as itself.
  const custom = parsePeriod(
    new URLSearchParams('period=custom&from=2026-04-30&to=2026-05-30'),
    TODAY,
  );
  const shared = parsePeriod(
    new URL(`https://example.test${periodHref('/app', custom)}`).searchParams,
    TODAY,
  );
  assert.deepEqual([shared.from, shared.to], ['2026-04-30', '2026-05-30']);
});

test('the comparison follows the selection', () => {
  assert.equal(previousPeriod(preset('this-month'))?.label, 'July 2026');
  assert.equal(previousPeriod(preset('this-year'))?.label, '2025');
  assert.equal(
    previousPeriod(parsePeriod(new URLSearchParams('period=2026-05-14'), TODAY))?.label,
    '13 May 2026',
  );
  // A quarter compares with the CALENDAR quarter before it, which is a period
  // the business closes its books on, not the 92 days before it.
  const quarter = previousPeriod(preset('this-quarter'));
  assert.deepEqual([quarter?.from, quarter?.to], ['2026-04-01', '2026-06-30']);
  assert.equal(quarter?.label, 'Q2 2026');
  assert.equal(previousPeriod(preset('all')), null);
});

test('a malformed period token is treated as absent, not as an error', () => {
  assert.equal(parsePeriod(new URLSearchParams('period=nonsense'), TODAY).key, 'this-month');
  assert.equal(parsePeriod(new URLSearchParams('period=2026-13'), TODAY).key, 'this-month');
  assert.equal(parsePeriod(new URLSearchParams(''), TODAY).key, 'this-month');
});

test('the calendar is one statement, and it reads the real schema', async () => {
  const db = createTestDb();
  await seedHass(db);
  const sql = calendarSql([
    { table: 'workflow_stage_instances', column: 'completed_at' },
    { table: 'sales_orders', column: 'invoice_created_at' },
  ]);
  // ONE statement. Marking every level plus the two extremes must not cost a
  // round trip per level, which is the whole reason the levels are unioned.
  assert.equal(sql.split(';').length, 1);
  const found = await db.execute({ sql, args: ['2026-08'] });
  const calendar = readCalendar(found.rows as Record<string, unknown>[]);
  assert.ok(calendar.years.has('2026'), 'the seed has 2026 activity');
  assert.ok(calendar.latest !== null);
  db.close();
});
