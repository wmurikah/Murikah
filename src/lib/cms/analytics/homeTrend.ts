/**
 * The Home turnaround trend, built in one place for two callers.
 *
 * It used to live inside the Home page, which was fine while the page always
 * drew it. The trend is now DEEP DETAIL: Home renders it behind a disclosure
 * most people never open, so the queries behind it stopped running on every
 * visit and moved to a fragment fetched on first expansion. The chart
 * construction moved here so the fragment and any future caller draw exactly
 * the same picture from the same rules — two copies of "what is the trend"
 * would disagree within a month.
 *
 * THE GRAIN IS MONTHS AND THE BUCKETS ARE ENUMERATED from the period rather
 * than taken from the rows, so a month with no approvals breaks the line
 * instead of being skipped — plotting only the buckets that returned rows
 * compresses a quiet quarter into the width of a month and draws a continuity
 * that did not happen. A missing bucket is null and never zero: "nothing was
 * approved" and "an approval took no time" are different statements.
 *
 * THE LINES ARE THE FUNCTIONS WITH HISTORY. Ordering comes from the trend
 * points themselves (each carries its function's configured order), so the
 * fragment does not need the approval board loaded merely to sort lines — a
 * board query here would duplicate the heaviest read on the page it was
 * deferred FROM, which is the trap the server-island rule warns about.
 */
import { lineChart, seriesToken, type Chart, type ChartPoint } from '../charts/svg.ts';
import { formatDuration } from './stats.ts';
import { approvalRecordsHref } from './leaderboard.ts';
import { EVERYONE, type ApprovalProcess, type TrendPoint } from '../repos/approvalSla.ts';
import { periodBuckets, periodFromToken, type ResolvedPeriod } from './period.ts';

export function buildHomeTrendChart(options: {
  points: TrendPoint[];
  process: ApprovalProcess;
  period: ResolvedPeriod;
  affiliateId: string | null;
  today: Date;
  /** Extra function ordering from the board, where the caller has it loaded. */
  boardOrder?: ReadonlyMap<string, number>;
}): Chart {
  const { points, process, period, affiliateId, today } = options;
  const enumerated = periodBuckets(period);
  const buckets =
    enumerated ??
    [...new Set(points.map((p) => p.bucket))]
      .sort()
      .map((key) => ({ key, label: key, token: key }));
  const byFunction = new Map<string, Map<string, number | null>>();
  for (const point of points) {
    const row = byFunction.get(point.fn) ?? new Map<string, number | null>();
    row.set(point.bucket, point.medianMinutes);
    byFunction.set(point.fn, row);
  }

  const order = new Map<string, number>(options.boardOrder ?? []);
  for (const point of points) if (!order.has(point.fn)) order.set(point.fn, point.order);
  const functions = [...order.entries()].sort((a, b) => a[1] - b[1]).map(([fn]) => fn);

  return lineChart(
    functions.map((fn, index) => ({
      name: fn,
      token: seriesToken(index),
      points: buckets.map<ChartPoint>((bucket) => {
        const value = byFunction.get(fn)?.get(bucket.key) ?? null;
        return {
          label: bucket.label,
          value,
          href:
            value === null
              ? undefined
              : approvalRecordsHref({
                  period: periodFromToken(bucket.token, today) ?? period,
                  affiliateId,
                  process,
                  view: 'completed',
                  fn,
                  actor: EVERYONE,
                }),
        };
      }),
    })),
    {
      unit: 'minutes',
      format: formatDuration,
      endLabels: true,
      area: true,
      categoryName: 'Month',
      xAxisLabel: 'Month',
      yAxisLabel: 'Minutes',
      emptyMessage: 'Need more history',
      // A LINE OVER ONE MONTH IS A DOT. Two months is the least that can show
      // a direction, so below it the panel says what it needs rather than
      // drawing a row of isolated points that reads as a scatter.
      minimumCategories: 2,
      height: 240,
    },
  );
}
