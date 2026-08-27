/**
 * Median, average and P90, computed in SQL and defined once.
 *
 * AGGREGATION HAPPENS IN THE DATABASE.
 * No endpoint in this application fetches a table and reduces it in
 * JavaScript. A month of sales order rows is tens of thousands of records; a
 * Worker has neither the memory nor the time, and the moment two pages
 * reduce the same rows in two loops they start disagreeing. libSQL has
 * window functions, so the database does the work and returns one row.
 *
 * THE DEFINITIONS, STATED ONCE AND SHOWN IN THE INTERFACE.
 *
 *   Median: the value at row (count + 1) / 2 by integer division, ordered
 *   ascending. On an ODD count that is the middle value. On an EVEN count
 *   integer division truncates, so it is the LOWER of the two middle values,
 *   never their mean. That is deliberate: every figure this application
 *   reports is a duration some order actually took, and the mean of two
 *   neighbours is a number no order ever recorded.
 *
 *   P90: the value at row (count * 9 + 9) / 10 by integer division, which is
 *   the nearest-rank ceiling of 0.9 x count. For 10 values it is the 9th,
 *   for 4 it is the 4th, for 1 it is the only one. Nearest-rank again, so
 *   the figure is always an observed value rather than an interpolation.
 *
 *   Average: the arithmetic mean of the same population, reported beside the
 *   median rather than instead of it, because a single very late order moves
 *   one and not the other and the difference is worth seeing.
 *
 * COVERAGE IS PART OF THE ANSWER.
 * `measured` counts the records that had the timestamps the metric needs;
 * `total` counts the records in the population. Where they differ the
 * interface says so, because an average across a partial population without
 * its denominator is exactly the kind of misleading number this application
 * exists to prevent. A NULL is never read as a zero.
 */
import type { Client } from '@libsql/client/web';

export interface DurationStats {
  /** Records that had the timestamps this metric needs. */
  measured: number;
  /** Records in the population, whether or not they could be measured. */
  total: number;
  medianMinutes: number | null;
  averageMinutes: number | null;
  p90Minutes: number | null;
  minimumMinutes: number | null;
  maximumMinutes: number | null;
}

export const MEDIAN_DEFINITION =
  'Median is the nearest-rank middle value, row (n + 1) / 2 by integer division. On an even count that is the lower of the two middle values, never their mean, so the figure is always a duration a real record took.';

export const P90_DEFINITION =
  'P90 is the nearest-rank 90th percentile, row (n * 9 + 9) / 10 by integer division: the value nine tenths of records came in under.';

/**
 * Minutes between two SQL timestamps. Both stored as "YYYY-MM-DD HH:MM:SS"
 * in UTC, so julianday differencing is exact and needs no date library.
 * Either end NULL yields NULL, which is what keeps an unmeasurable record
 * out of the population instead of contributing a zero.
 */
export function minutesBetweenSql(from: string, to: string): string {
  // Rounded to three decimals: julianday arithmetic is floating point, and
  // without this an exact 80-minute stage reads 79.9999999254942, which then
  // prints as a duration nobody recognises and compares unequal to itself.
  return `CASE WHEN ${from} IS NULL OR ${to} IS NULL THEN NULL
               ELSE ROUND((julianday(${to}) - julianday(${from})) * 1440.0, 3) END`;
}

export interface StatsQuery {
  /** The expression yielding one duration in minutes, NULL where unmeasurable. */
  valueSql: string;
  /** Everything after FROM, joins included. */
  source: string;
  /** The WHERE body, scope predicate included. */
  where: string;
}

/**
 * One row: coverage, median, average, P90 and the range. The population is
 * evaluated once in a CTE and read six ways, so the filters and the scope
 * predicate are applied exactly once and cannot drift between the figures.
 */
export function statsSql(query: StatsQuery): string {
  return `
    WITH population AS (
      SELECT ${query.valueSql} AS v
      FROM ${query.source}
      WHERE ${query.where}
    ),
    measured AS (SELECT v FROM population WHERE v IS NOT NULL),
    ranked AS (
      SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn, COUNT(*) OVER () AS c FROM measured
    )
    SELECT
      (SELECT COUNT(*) FROM measured) AS measured,
      (SELECT COUNT(*) FROM population) AS total,
      (SELECT v FROM ranked WHERE rn = (c + 1) / 2) AS median_minutes,
      (SELECT AVG(v) FROM measured) AS average_minutes,
      (SELECT v FROM ranked WHERE rn = (c * 9 + 9) / 10) AS p90_minutes,
      (SELECT MIN(v) FROM measured) AS minimum_minutes,
      (SELECT MAX(v) FROM measured) AS maximum_minutes`;
}

const number = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export async function durationStats(
  db: Client,
  query: StatsQuery,
  args: (string | number)[],
): Promise<DurationStats> {
  const result = await db.execute({ sql: statsSql(query), args: args as never[] });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  return {
    measured: Number(row.measured ?? 0),
    total: Number(row.total ?? 0),
    medianMinutes: number(row.median_minutes),
    averageMinutes: number(row.average_minutes),
    p90Minutes: number(row.p90_minutes),
    minimumMinutes: number(row.minimum_minutes),
    maximumMinutes: number(row.maximum_minutes),
  };
}

/** The sentence that goes beside every duration figure. */
export function coverageSentence(stats: DurationStats, noun: string): string {
  if (stats.total === 0) return `No ${noun} in this selection.`;
  if (stats.measured === stats.total) {
    return `All ${stats.total.toLocaleString('en-KE')} ${noun} have the timestamps this metric needs.`;
  }
  return `${stats.measured.toLocaleString('en-KE')} of ${stats.total.toLocaleString('en-KE')} ${noun} have the timestamps this metric needs. The rest are not available and are excluded, never counted as zero.`;
}

/**
 * A duration for a person to read. Minutes below an hour, hours and minutes
 * below a day, then days and hours. A null is "Not available", which is a
 * different statement from "0 min" and the difference matters on nearly
 * every screen in this batch.
 */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return 'Not available';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  if (total < 1440) {
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(total / 1440);
  const hours = Math.round((total % 1440) / 60);
  return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
}

/** A percentage, or "Not available" where the denominator is zero. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function formatRate(value: number | null): string {
  return value === null ? 'Not available' : `${value}%`;
}
