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
  monthOf,
  monthToken,
  parseDashboardPeriod,
  parsePeriod,
  periodBuckets,
  periodFromToken,
  periodHasData,
  periodHref,
  presetPeriod,
  previousPeriod,
  readCalendar,
  readCalendars,
  trailingMonths,
  trendSpan,
  type DataCalendar,
  type ResolvedPeriod,
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

/* ---------------------------------------------------------------------------
 * Build Prompt 40, section 4a: the panel that was empty while data existed
 * ------------------------------------------------------------------------ */

test('a calendar built over the wrong rows lets an empty panel render in silence', async () => {
  // THE REPRODUCTION, KEPT. On 30 August 2026 Home showed an empty purchase
  // order chart and an empty table while 2,624 completions existed, and the
  // fallback never fired. The cause was not the period resolution — that
  // happens once — it was the data check: the calendar counted every entity
  // type in workflow_stage_instances, so a LEAD completed in August answered
  // "August has data" on behalf of a purchase order board whose data ran 1 to
  // 30 May.
  const db = createTestDb();
  await seedHass(db);
  for (let i = 1; i <= 4; i += 1) {
    const n = String(i).padStart(2, '0');
    const day = String(i + 9).padStart(2, '0');
    await db.execute(
      `INSERT INTO purchase_orders (purchase_order_id, document_number, affiliate_id, po_created_at, status)
       VALUES ('PO-M${n}','DOC-M${n}','AFF-KE','2026-05-${day} 07:00:00','APPROVED')`,
    );
    await db.execute(
      `INSERT INTO workflow_instances VALUES
       ('WFI-M${n}','WFD-002','PURCHASE_ORDER','PO-M${n}','COMPLETED','2026-05-${day} 08:00:00','2026-05-${day} 09:00:00','WST-005',CURRENT_TIMESTAMP)`,
    );
    await db.execute(
      `INSERT INTO workflow_stage_instances VALUES
       ('WSI-M${n}','WFI-M${n}','WST-005','USR-GAB','TEAM-FIN-KE','APPROVED','2026-05-${day} 08:00:00','2026-05-${day} 08:00:00','2026-05-${day} 09:00:00','ok')`,
    );
  }

  // THE OLD SHAPE: one unioned population, no series, no entity_type filter.
  const mixed = readCalendar(
    (
      await db.execute({
        sql: calendarSql([{ table: 'workflow_stage_instances', column: 'completed_at' }]),
        args: ['2026-08'],
      })
    ).rows as Record<string, unknown>[],
  );
  const august = parsePeriod(new URLSearchParams(), TODAY);
  assert.equal(august.label, 'August 2026');
  assert.equal(
    periodHasData(august, mixed),
    true,
    'the mixed calendar claims August holds data, which is how the fallback was skipped',
  );

  // THE FIX: the same single statement, with each source labelled, so the
  // purchase order board's own question gets its own answer.
  const set = readCalendars(
    (
      await db.execute({
        sql: calendarSql([
          {
            table: 'workflow_stage_instances',
            column: 'completed_at',
            series: 'PURCHASE_ORDER',
            where: `workflow_instance_id IN (
              SELECT workflow_instance_id FROM workflow_instances WHERE entity_type = 'PURCHASE_ORDER')`,
          },
          {
            table: 'workflow_stage_instances',
            column: 'completed_at',
            series: 'SALES_ORDER',
            where: `workflow_instance_id IN (
              SELECT workflow_instance_id FROM workflow_instances WHERE entity_type = 'SALES_ORDER')`,
          },
        ]),
        args: ['2026-08'],
      })
    ).rows as Record<string, unknown>[],
  );

  const purchases = set.series.get('PURCHASE_ORDER')!;
  assert.equal(
    periodHasData(august, purchases),
    false,
    'the purchase order board has no August activity, and now says so',
  );
  assert.equal(purchases.latest?.slice(0, 7), '2026-05', 'its data is in May, one period away');
  // The sales board genuinely does have August activity, which is why the two
  // panels differed and why one calendar for the page could never be right.
  assert.equal(periodHasData(august, set.series.get('SALES_ORDER')!), true);
  // And the page's own period is still resolved from ONE combined calendar.
  assert.ok(set.combined.total >= purchases.total, 'the combined population is the page-wide one');
  db.close();
});

test('the calendar is still one statement once it carries a series', () => {
  const sql = calendarSql([
    { table: 'workflow_stage_instances', column: 'completed_at', series: 'PURCHASE_ORDER' },
    { table: 'sales_orders', column: 'invoice_created_at', series: 'SALES_ORDER' },
  ]);
  // Answering the question per board must not cost a query per board.
  assert.equal(sql.split(';').length, 1);
});

/* -------------------------------------------------------------------------
 * Phase 4.2: the dashboard trend is a run of months
 * ------------------------------------------------------------------------- */

test('the trend window is whole months, bucketed by month whatever its span', () => {
  const may = periodFromToken('2026-05', TODAY) as ResolvedPeriod;

  // TWO MONTHS IS SIXTY-ONE DAYS, and `grainFor` reads sixty-one days as DAY.
  // Inheriting that grain made `periodBuckets` enumerate sixty-one daily keys
  // against a query returning two monthly ones: nothing matched and the trend
  // drew "no data" with the rows in hand. The window is months by construction.
  const short = trailingMonths(may, 2);
  assert.equal(short.grain, 'MONTH');
  assert.equal(short.from, '2026-04-01');
  assert.equal(short.to, '2026-05-31');
  assert.deepEqual(
    (periodBuckets(short) ?? []).map((bucket) => bucket.key),
    ['2026-04', '2026-05'],
  );

  // A full year still ends at the month on screen and starts eleven back.
  const year = trailingMonths(may, 12);
  assert.equal(year.grain, 'MONTH');
  assert.equal(year.from, '2025-06-01');
  assert.equal(year.to, '2026-05-31');
  assert.equal((periodBuckets(year) ?? []).length, 12);
  // Inside a year no month repeats, so a bucket is named by its month alone.
  assert.deepEqual(
    (periodBuckets(year) ?? []).slice(0, 2).map((bucket) => bucket.label),
    ['Jun', 'Jul'],
  );
});

test('the trend spans the data it has, never a year of empty columns', () => {
  const may = periodFromToken('2026-05', TODAY) as ResolvedPeriod;
  const twoMonths = EXTRACT;
  // The one extract covers two months. A twelve-column axis would draw ten
  // blank ones and squeeze the line into the last inch, which is the clustered
  // reading a trend exists to replace.
  assert.equal(trendSpan(may, twoMonths), 2);

  const wide: DataCalendar = { ...EXTRACT, months: new Set(['2023-01', '2026-05']) };
  assert.equal(trendSpan(may, wide), 12, 'and never more than a year');

  // Two is the floor: one column is a bar, not a trend.
  const single: DataCalendar = { ...EXTRACT, months: new Set(['2026-05']) };
  assert.equal(trendSpan(may, single), 2);
});

test('a month and a year name the period, from either shape of URL', () => {
  // The control posts month and year; every drill and every link elsewhere
  // carries the one token the rest of the application speaks. Both land here.
  const fromControl = parseDashboardPeriod(
    new URLSearchParams({ month: '5', year: '2026' }),
    TODAY,
  );
  assert.equal(fromControl.period.key, '2026-05');
  assert.equal(fromControl.chosen, true);

  const fromToken = parseDashboardPeriod(new URLSearchParams({ period: '2026-05' }), TODAY);
  assert.equal(fromToken.period.key, '2026-05');
  assert.equal(fromToken.chosen, true);

  // A period the two dropdowns cannot express still arrives, as the month its
  // window ends in, so a link from an analytics page is never a dead end.
  const fromYear = parseDashboardPeriod(new URLSearchParams({ period: '2026' }), TODAY);
  assert.equal(fromYear.period.level, 'MONTH');
  assert.equal(fromYear.period.key, '2026-12');

  // Nothing chosen is nothing chosen, so the fallback may still move it.
  assert.equal(parseDashboardPeriod(new URLSearchParams(), TODAY).chosen, false);

  // And the round trip the control depends on.
  const at = monthOf(periodFromToken('2026-05', TODAY) as ResolvedPeriod, TODAY);
  assert.deepEqual(at, { month: 5, year: 2026 });
  assert.equal(monthToken(at.month, at.year), '2026-05');
});
