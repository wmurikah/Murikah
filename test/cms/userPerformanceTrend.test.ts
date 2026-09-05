import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoadingAuthorityTrend,
  buildUserPerformanceTrend,
  USER_TREND_MONTHS,
} from '../../src/lib/cms/analytics/userPerformanceTrend.ts';

const valueTickLabels = (svg: string): string[] =>
  [...svg.matchAll(/text-anchor="end" font-size="11" fill="var\(--color-cms-muted\)">([^<]+)<\/text>/g)].map(
    (match) => match[1] ?? '',
  );

const UNIFORM_HOUR_LABELS = [
  '1 hr',
  '2 hrs',
  '3 hrs',
  '4 hrs',
  '5 hrs',
  '6 hrs',
  '7 hrs',
  '8 hrs',
  '9 hrs',
  '10 hrs',
];

test('a user trend always spans Jan to Dec and preserves missing months as null', () => {
  const chart = buildUserPerformanceTrend({
    year: 2026,
    noun: 'approvals',
    emptyMessage: 'No approval history available for this period.',
    points: [
      {
        affiliateId: null,
        userId: 'USR-1',
        person: 'Test Approver',
        bucket: '2026-04',
        volume: 18,
        averageMinutes: 42,
      },
    ],
  });

  assert.deepEqual(
    chart.table.rows.map((row) => row[0]),
    USER_TREND_MONTHS,
  );
  assert.equal(chart.table.rows[0]![1], 'Not available');
  assert.equal(chart.table.rows[3]![1], '42 min · 18 approvals');
  assert.match(chart.svg, /Test Approver\nApril 2026\nAverage: 42 min\nApprovals: 18/);
});

test('Purchase Order Home trend uses the fixed 1-to-10-hour y-axis with the axis line retained', () => {
  const chart = buildUserPerformanceTrend({
    year: 2026,
    noun: 'completions',
    targetMinutes: 30,
    emptyMessage: 'No completion history available for this period.',
    points: [
      {
        affiliateId: 'AFF-KE',
        userId: 'USR-1',
        person: 'Test User',
        bucket: '2026-01',
        volume: 1,
        averageMinutes: 64,
      },
    ],
  });

  assert.deepEqual(valueTickLabels(chart.svg), UNIFORM_HOUR_LABELS);
  assert.match(chart.svg, /data-home-y-axis="true"/);
  assert.equal((chart.svg.match(/data-home-y-tick="/g) ?? []).length, 10);
  assert.doesNotMatch(chart.svg, />MINUTES<\/text>/);
  assert.doesNotMatch(chart.svg, /Target · 30 min/);
  assert.doesNotMatch(chart.svg, /__HOME_10_HOUR_SCALE__/);
  assert.deepEqual(chart.legend, [{ name: 'Test User', token: 'cms-series-1' }]);
  assert.equal(chart.table.rows[0]![1], '1 h 4 min · 1 completion');
});

test('Loading Authority uses the exact same 1-to-10-hour y-axis as Purchase Order', () => {
  const chart = buildLoadingAuthorityTrend({
    year: 2026,
    entities: [
      { affiliateId: 'AFF-KE', code: 'HPK' },
      { affiliateId: 'AFF-UG', code: 'HPU' },
    ],
    targetMinutes: 30,
    points: [
      {
        affiliateId: 'AFF-KE',
        bucket: '2026-08',
        volume: 2,
        averageMinutes: 75,
        targetMinutes: 30,
      },
    ],
  });

  assert.deepEqual(chart.legend, [
    { name: 'HPK', token: 'cms-series-1' },
    { name: 'HPU', token: 'cms-series-2' },
  ]);
  assert.deepEqual(valueTickLabels(chart.svg), UNIFORM_HOUR_LABELS);
  assert.match(chart.svg, /data-home-y-axis="true"/);
  assert.equal((chart.svg.match(/data-home-y-tick="/g) ?? []).length, 10);
  assert.doesNotMatch(chart.svg, />MINUTES<\/text>/);
  assert.doesNotMatch(chart.svg, /Target · 30 min/);
  assert.equal(chart.table.rows[0]![1], 'Not available');
  assert.equal(chart.table.rows[7]![1], '1 h 15 min · 2 completions');
  assert.match(chart.svg, /HPK\nAugust 2026\nAverage: 1 h 15 min\nCompletions: 2/);
});

test('durations above ten hours are capped visually but exact data remains in the table', () => {
  const chart = buildLoadingAuthorityTrend({
    year: 2026,
    entities: [{ affiliateId: 'AFF-KE', code: 'HPK' }],
    points: [
      {
        affiliateId: 'AFF-KE',
        bucket: '2026-08',
        volume: 1,
        averageMinutes: 900,
        targetMinutes: 30,
      },
    ],
  });

  assert.deepEqual(valueTickLabels(chart.svg), UNIFORM_HOUR_LABELS);
  assert.match(chart.svg, />10 h\+<\/text>/);
  assert.equal(chart.table.rows[7]![1], '15 h · 1 completion');
  assert.match(chart.svg, /Average: 15 h/);
});
