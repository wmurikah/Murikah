import {
  lineChart,
  seriesToken,
  type Chart,
  type ChartPoint,
  type ChartSeries,
} from '../charts/svg.ts';
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

/** Both Home duration trends deliberately share one visual comparison scale. */
const HOME_AXIS_MAX_MINUTES = 10 * 60;
/**
 * The shared SVG renderer chooses pleasant ceilings at 1/2/5/10 steps. Mapping
 * ten hours to 1000 gives us a stable exact ceiling without changing any other
 * chart in the application.
 */
const HOME_AXIS_INTERNAL_MAX = 1000;
const HOME_AXIS_SCALE_REFERENCE = '__HOME_10_HOUR_SCALE__';
const HOUR_TICKS = Array.from({ length: 11 }, (_unused, index) => index);
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

function axisValue(minutes: number | null): number | null {
  if (minutes === null) return null;
  const clipped = Math.min(Math.max(minutes, 0), HOME_AXIS_MAX_MINUTES);
  return (clipped / HOME_AXIS_MAX_MINUTES) * HOME_AXIS_INTERNAL_MAX;
}

/**
 * Only the plotted position is capped at ten hours. Exact underlying durations
 * remain in the tooltip, data table and accessible description. An over-scale
 * isolated point is therefore labelled `10 h+`, never falsely reported as ten
 * hours exactly.
 */
function formatAxisPlotValue(value: number | null): string {
  if (value === null) return 'Not available';
  if (value >= HOME_AXIS_INTERNAL_MAX) return '10 h+';
  return formatDuration((value / HOME_AXIS_INTERNAL_MAX) * HOME_AXIS_MAX_MINUTES);
}

function scaledSeries(series: readonly ChartSeries[]): ChartSeries[] {
  return series.map((one) => ({
    ...one,
    points: one.points.map((point) => ({ ...point, value: axisValue(point.value) })),
  }));
}

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Replace the generic three-label frame with the one Home comparison axis:
 * a visible y-axis rule and labels from 0 through 10 hours. The x-axis
 * baseline remains untouched. No `MINUTES` heading is drawn.
 */
function withUniformHourAxis(chart: Chart): Chart {
  const matches = [...chart.svg.matchAll(VALUE_TICK)];
  if (matches.length < 3) return chart;

  const bottom = matches[0];
  const top = matches[2];
  const labelX = Number(bottom?.[1]);
  const bottomLabelY = Number(bottom?.[2]);
  const topLabelY = Number(top?.[2]);
  if (![labelX, bottomLabelY, topLabelY].every(Number.isFinite)) return chart;

  const axisX = labelX + 8;
  const bottomY = bottomLabelY - 4;
  const topY = topLabelY - 4;
  const axis =
    `<line data-home-y-axis="true" x1="${axisX}" y1="${topY}" x2="${axisX}" y2="${bottomY}" ` +
    `stroke="var(--color-cms-line)" stroke-width="1" />`;

  const ticks = HOUR_TICKS.map((hour) => {
    const fraction = hour / 10;
    const lineY = bottomY + (topY - bottomY) * fraction;
    const textY = lineY + 4;
    const label = hour === 0 ? '0' : hour === 1 ? '1 hr' : `${hour} hrs`;
    return (
      `<line data-home-y-tick="${hour}" x1="${axisX - 4}" y1="${Math.round(lineY * 100) / 100}" ` +
      `x2="${axisX}" y2="${Math.round(lineY * 100) / 100}" stroke="var(--color-cms-line)" stroke-width="1" />` +
      `<text x="${labelX}" y="${Math.round(textY * 100) / 100}" text-anchor="end" font-size="11" ` +
      `fill="var(--color-cms-muted)">${label}</text>`
    );
  }).join('');

  let seen = 0;
  let svg = chart.svg.replace(VALUE_TICK, (match) => {
    seen += 1;
    if (seen === 1) return axis + ticks;
    if (seen <= 3) return '';
    return match;
  });

  // The sentinel reference exists only to force the shared renderer's ceiling
  // to exactly 1000 internal units. It must never be visible to the reader.
  svg = svg.replace(/<line [^>]*stroke-dasharray="4 3" \/>/g, '');
  svg = svg.replace(
    new RegExp(`<text[^>]*>${HOME_AXIS_SCALE_REFERENCE}<\\/text>`, 'g'),
    '',
  );

  return { ...chart, svg };
}

function buildHomeTrendChart(series: ChartSeries[], emptyMessage: string): Chart {
  const common = {
    unit: 'minutes',
    height: 300,
    categoryName: 'Month',
    xAxisLabel: 'Month',
    endLabels: false,
    emptyMessage,
  } as const;

  // Build once with exact values for the table/alt text and once with the
  // presentation scale. This keeps the visual comparison fixed at 10 hours
  // without changing or truncating the underlying reported durations.
  const exact = lineChart(series, { ...common, format: formatDuration });
  const display = lineChart(scaledSeries(series), {
    ...common,
    format: formatAxisPlotValue,
    reference: { value: HOME_AXIS_INTERNAL_MAX, label: HOME_AXIS_SCALE_REFERENCE },
  });
  const clean = withUniformHourAxis(display);
  const svg = clean.svg.replace(
    /aria-label="[^"]*"/,
    `aria-label="${escapeAttribute(exact.alt)}"`,
  );
  return { ...clean, svg, alt: exact.alt, table: exact.table };
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
  const series: ChartSeries[] = [...byUser.entries()]
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

  return buildHomeTrendChart(series, options.emptyMessage);
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

  const series: ChartSeries[] = [...options.entities]
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

  return buildHomeTrendChart(series, 'No Loading Authority history available for this period.');
}

export { MONTHS as USER_TREND_MONTHS };
