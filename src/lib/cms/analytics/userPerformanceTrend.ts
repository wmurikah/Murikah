import { lineChart, seriesToken, type Chart, type ChartPoint } from '../charts/svg.ts';
import { formatDuration } from './stats.ts';
import type { LoadingAuthorityTrendPoint, UserTrendPoint } from '../repos/approvalSla.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const FIVE_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
const VALUE_TICK =
  /<text x="([^"]+)" y="([^"]+)" text-anchor="end" font-size="11" fill="var\(--color-cms-muted\)">[^<]*<\/text>/g;

/** A compact, readable series name. Keep the full identity in the tooltip. */
function compactUserName(name: string, allNames: readonly string[]): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  const sameFirst = allNames.filter((candidate) => {
    const candidateFirst = candidate.trim().split(/\s+/).filter(Boolean)[0] ?? candidate;
    return candidateFirst.toLocaleLowerCase() === first.toLocaleLowerCase();
  });
  if (sameFirst.length <= 1 || parts.length <= 1) return first;
  const last = parts[parts.length - 1] ?? '';
  return `${first} ${last.slice(0, 1)}.`;
}

/** Keep the same pleasant rounded ceiling as the shared SVG chart renderer. */
function niceCeiling(maximum: number): number {
  if (!Number.isFinite(maximum) || maximum <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maximum)));
  const scaled = maximum / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Home trends need a slightly more readable value scale than the shared
 * three-label line-chart frame. Replace only that frame's three value labels
 * with five evenly spaced labels; the shared chart geometry and all plotted
 * coordinates remain untouched.
 */
function withFiveValueTicks(chart: Chart, values: readonly number[]): Chart {
  const matches = [...chart.svg.matchAll(VALUE_TICK)];
  if (matches.length < 3) return chart;

  const bottom = matches[0];
  const top = matches[2];
  const x = bottom?.[1];
  const bottomY = Number(bottom?.[2]);
  const topY = Number(top?.[2]);
  if (x === undefined || !Number.isFinite(bottomY) || !Number.isFinite(topY)) return chart;

  const ceiling = niceCeiling(Math.max(0, ...values));
  const replacement = FIVE_TICKS.map((fraction) => {
    const y = bottomY + (topY - bottomY) * fraction;
    return (
      `<text x="${x}" y="${Math.round(y * 100) / 100}" text-anchor="end" font-size="11" ` +
      `fill="var(--color-cms-muted)">${formatDuration(ceiling * fraction)}</text>`
    );
  }).join('');

  let seen = 0;
  const svg = chart.svg.replace(VALUE_TICK, (match) => {
    seen += 1;
    if (seen === 1) return replacement;
    if (seen <= 3) return '';
    return match;
  });
  return { ...chart, svg };
}

/** Build twelve chronological months; absent transactions remain null points. */
export function buildUserPerformanceTrend(options: {
  points: UserTrendPoint[];
  year: number;
  noun: 'approvals' | 'completions';
  targetMinutes?: number;
  emptyMessage: string;
}): Chart {
  const byUser = new Map<string, { name: string; months: Map<string, UserTrendPoint> }>();
  for (const point of options.points) {
    const user = byUser.get(point.userId) ?? { name: point.person, months: new Map() };
    user.months.set(point.bucket, point);
    byUser.set(point.userId, user);
  }

  const allNames = [...byUser.values()].map((user) => user.name);
  const series = [...byUser.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([, user], index) => ({
      name: compactUserName(user.name, allNames),
      token: seriesToken(index),
      points: MONTHS.map<ChartPoint>((label, month) => {
        const bucket = `${options.year}-${String(month + 1).padStart(2, '0')}`;
        const point = user.months.get(bucket);
        return {
          label,
          value: point?.averageMinutes ?? null,
          detail:
            point === undefined
              ? undefined
              : `${point.volume} ${point.volume === 1 ? options.noun.slice(0, -1) : options.noun}`,
          tooltip:
            point === undefined
              ? undefined
              : `${user.name}\n${MONTH_NAMES[month]} ${options.year}\nAverage: ${formatDuration(point.averageMinutes)}\n${options.noun === 'approvals' ? 'Approvals' : 'Completions'}: ${point.volume}`,
        };
      }),
    }));

  const chart = lineChart(series, {
    unit: 'minutes',
    format: formatDuration,
    height: 300,
    categoryName: 'Month',
    xAxisLabel: 'Month',
    yAxisLabel: 'Minutes',
    endLabels: false,
    emptyMessage: options.emptyMessage,
  });
  return withFiveValueTicks(
    chart,
    options.points.map((point) => point.averageMinutes),
  );
}

export function buildLoadingAuthorityTrend(options: {
  points: LoadingAuthorityTrendPoint[];
  year: number;
  entities: readonly { affiliateId: string; code: string }[];
  targetMinutes?: number;
}): Chart {
  const pointMap = new Map<string, Map<string, LoadingAuthorityTrendPoint>>();
  for (const point of options.points) {
    const months = pointMap.get(point.affiliateId) ?? new Map<string, LoadingAuthorityTrendPoint>();
    months.set(point.bucket, point);
    pointMap.set(point.affiliateId, months);
  }

  const series = [...options.entities]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((entity, index) => {
      const byMonth = pointMap.get(entity.affiliateId) ?? new Map<string, LoadingAuthorityTrendPoint>();
      return {
        name: entity.code,
        token: seriesToken(index),
        points: MONTHS.map<ChartPoint>((label, month) => {
          const point = byMonth.get(`${options.year}-${String(month + 1).padStart(2, '0')}`);
          return {
            label,
            value: point?.averageMinutes ?? null,
            detail:
              point === undefined
                ? undefined
                : `${point.volume} ${point.volume === 1 ? 'completion' : 'completions'}`,
            tooltip:
              point === undefined
                ? undefined
                : `${entity.code}\n${MONTH_NAMES[month]} ${options.year}\nAverage: ${formatDuration(point.averageMinutes)}\nCompletions: ${point.volume}`,
          };
        }),
      };
    });

  const chart = lineChart(series, {
    unit: 'minutes',
    format: formatDuration,
    height: 300,
    categoryName: 'Month',
    xAxisLabel: 'Month',
    yAxisLabel: 'Minutes',
    endLabels: false,
    emptyMessage: 'No Loading Authority history available for this period.',
  });
  return withFiveValueTicks(
    chart,
    options.points.map((point) => point.averageMinutes),
  );
}

export { MONTHS as USER_TREND_MONTHS };
