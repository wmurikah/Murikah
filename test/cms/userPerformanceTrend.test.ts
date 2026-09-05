import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoadingAuthorityTrend,
  buildUserPerformanceTrend,
  USER_TREND_MONTHS,
} from '../../src/lib/cms/analytics/userPerformanceTrend.ts';

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

test('a user trend reuses the configured target and existing series palette', () => {
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

  assert.match(chart.svg, /Target · 30 min/);
  assert.deepEqual(chart.legend, [{ name: 'Test User', token: 'cms-series-1' }]);
  assert.equal(chart.table.rows[0]![1], '1 h 4 min · 1 completion');
});

test('Loading Authority trend renders affiliate series with null months and completion context', () => {
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
  assert.equal(chart.table.rows[0]![1], 'Not available');
  assert.equal(chart.table.rows[7]![1], '1 h 15 min · 2 completions');
  assert.match(chart.svg, /HPK\nAugust 2026\nAverage: 1 h 15 min\nCompletions: 2/);
});
