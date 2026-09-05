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

  const series = [...byUser.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([, user], index) => ({
      name: user.name,
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

  return lineChart(series, {
    unit: 'minutes',
    format: formatDuration,
    height: 300,
    categoryName: 'Month',
    xAxisLabel: 'Month',
    yAxisLabel: 'Minutes',
    endLabels: false,
    emptyMessage: options.emptyMessage,
    reference:
      options.targetMinutes === undefined
        ? undefined
        : {
            value: options.targetMinutes,
            label: `Target · ${formatDuration(options.targetMinutes)}`,
          },
  });
}

export function buildLoadingAuthorityTrend(options: {
  points: LoadingAuthorityTrendPoint[];
  year: number;
  entity: string;
  targetMinutes?: number;
}): Chart {
  const byMonth = new Map(options.points.map((point) => [point.bucket, point]));
  return lineChart(
    [
      {
        name: `${options.entity} Loading Authority`,
        token: seriesToken(0),
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
                : `${options.entity}\n${MONTH_NAMES[month]} ${options.year}\nAverage: ${formatDuration(point.averageMinutes)}\nCompletions: ${point.volume}`,
          };
        }),
      },
    ],
    {
      unit: 'minutes',
      format: formatDuration,
      height: 300,
      categoryName: 'Month',
      xAxisLabel: 'Month',
      yAxisLabel: 'Minutes',
      emptyMessage: 'No Loading Authority history available for this period.',
      reference:
        options.targetMinutes === undefined
          ? undefined
          : {
              value: options.targetMinutes,
              label: `Target · ${formatDuration(options.targetMinutes)}`,
            },
    },
  );
}

export { MONTHS as USER_TREND_MONTHS };
