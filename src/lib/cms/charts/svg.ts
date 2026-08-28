/**
 * The chart module. One implementation, six phases, no dependency.
 *
 * WHY THERE IS NO CHARTING LIBRARY HERE.
 * A line, a bar, a stacked bar and a distribution are a handful of
 * coordinates. Chart.js is 70 kilobytes before a single pixel; this
 * repository ships roughly one kilobyte of gzipped JavaScript in total, and
 * a dashboard that arrives as markup renders before a script would have
 * finished parsing, works with JavaScript disabled and prints correctly.
 * These functions take the values the server has already aggregated in SQL
 * and return SVG.
 *
 * NO COLOUR IS WRITTEN HERE.
 * Every fill and stroke is a `var(--color-cms-*)` token from
 * src/styles/tokens.css. There is no hex literal in this file, and adding
 * one would put a colour outside the one place the design system defines
 * colours.
 *
 * AN SVG IS NOT READABLE BY A SCREEN READER.
 * Every chart returns three things: the markup, a sentence describing what
 * it shows, and the same numbers as a table. The component renders all
 * three, the table inside a disclosure, so the chart is decoration over data
 * that is present either way.
 */

export interface ChartPoint {
  /** The category or period, as it will be read aloud. */
  label: string;
  value: number | null;
  /** Where clicking this point should lead, if anywhere. */
  href?: string;
}

export interface ChartSeries {
  name: string;
  /** A token name without the `--color-` prefix, for example `cms-royal`. */
  token: string;
  points: ChartPoint[];
}

export interface ChartTable {
  columns: string[];
  rows: string[][];
}

export interface Chart {
  /** The SVG markup, ready for `set:html`. */
  svg: string;
  /** The sentence a screen reader hears in place of the picture. */
  alt: string;
  /** The same numbers, for the disclosure beneath the chart. */
  table: ChartTable;
}

export interface ChartOptions {
  /** What the values are, for the alternative text: "orders", "minutes". */
  unit?: string;
  /** How a value is rendered in the table and the labels. */
  format?: (value: number | null) => string;
  width?: number;
  height?: number;
  /** Drawn on the value axis, for a target or a threshold. */
  reference?: { value: number; label: string };
}

/** Above this many points a line carries no markers. See lineChart. */
const MARKER_LIMIT = 14;

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 240;
const PADDING = { top: 16, right: 16, bottom: 34, left: 56 };

/** The palette, in the order series are added. Tokens only, never a hex. */
export const SERIES_TOKENS = [
  'cms-series-1',
  'cms-series-2',
  'cms-series-3',
  'cms-series-4',
  'cms-series-5',
] as const;

const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const round = (value: number): string => (Math.round(value * 100) / 100).toString();

function defaultFormat(value: number | null): string {
  if (value === null) return 'Not available';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * The value axis ceiling. A chart whose tallest bar touches the frame reads
 * as truncated, so the scale is rounded up to something a person would
 * choose. A series with no values at all scales to one, which draws an empty
 * frame rather than dividing by zero.
 */
function niceCeiling(maximum: number): number {
  if (!Number.isFinite(maximum) || maximum <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maximum)));
  const scaled = maximum / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * The value axis: three labels and one baseline.
 *
 * IT USED TO DRAW THREE GRIDLINES. Every pixel that is not carrying
 * information competes with the pixels that are, and a line across the middle
 * of a chart carries none: the reader is not measuring against it, they are
 * reading the shape and, when they want the number, the table underneath. The
 * labels stay, because they say what the chart's range is; the baseline stays,
 * because a series has to sit on something. The two rules in between have
 * gone.
 */
function frame(
  width: number,
  height: number,
  ceiling: number,
  format: (v: number | null) => string,
): string {
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const baseY = PADDING.top + innerHeight;
  const labels = [0, 0.5, 1]
    .map((fraction) => {
      const y = PADDING.top + innerHeight * (1 - fraction);
      return (
        `<text x="${PADDING.left - 8}" y="${round(y + 4)}" text-anchor="end" font-size="11" ` +
        `fill="var(--color-cms-muted)">${escape(format(ceiling * fraction))}</text>`
      );
    })
    .join('');
  return (
    `<line x1="${PADDING.left}" y1="${round(baseY)}" x2="${width - PADDING.right}" ` +
    `y2="${round(baseY)}" stroke="var(--color-cms-line)" stroke-width="1" />` +
    labels
  );
}

function categoryLabels(labels: string[], width: number, height: number): string {
  const inner = width - PADDING.left - PADDING.right;
  const step = inner / Math.max(labels.length, 1);
  // A label every nth category, so a year of weeks does not overprint itself.
  const stride = Math.max(1, Math.ceil(labels.length / 12));
  return labels
    .map((label, index) => {
      if (index % stride !== 0) return '';
      const x = PADDING.left + step * (index + 0.5);
      return (
        `<text x="${round(x)}" y="${height - PADDING.bottom + 16}" text-anchor="middle" ` +
        `font-size="11" fill="var(--color-cms-muted)">${escape(label)}</text>`
      );
    })
    .join('');
}

function referenceLine(
  reference: ChartOptions['reference'],
  ceiling: number,
  width: number,
  height: number,
): string {
  if (reference === undefined) return '';
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const y = PADDING.top + innerHeight * (1 - Math.min(reference.value / ceiling, 1));
  return (
    `<line x1="${PADDING.left}" y1="${round(y)}" x2="${width - PADDING.right}" y2="${round(y)}" ` +
    `stroke="var(--color-cms-ink-600)" stroke-width="1" stroke-dasharray="4 3" />` +
    `<text x="${width - PADDING.right}" y="${round(y - 5)}" text-anchor="end" font-size="11" ` +
    `fill="var(--color-cms-ink-600)">${escape(reference.label)}</text>`
  );
}

function tableOf(series: ChartSeries[], format: (v: number | null) => string): ChartTable {
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  return {
    columns: ['Period', ...series.map((one) => one.name)],
    rows: labels.map((label, index) => [
      label,
      ...series.map((one) => format(one.points[index]?.value ?? null)),
    ]),
  };
}

function altOf(series: ChartSeries[], unit: string, format: (v: number | null) => string): string {
  return series
    .map((one) => {
      const values = one.points.filter((point) => point.value !== null);
      if (values.length === 0) return `${one.name}: no values available.`;
      const first = values[0];
      const last = values[values.length - 1];
      const peak = values.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a));
      return (
        `${one.name}: ${values.length} points in ${unit}, ` +
        `from ${format(first?.value ?? null)} at ${first?.label} ` +
        `to ${format(last?.value ?? null)} at ${last?.label}, ` +
        `highest ${format(peak.value)} at ${peak.label}.`
      );
    })
    .join(' ');
}

/**
 * A bar chart. Missing values leave a gap with a marker rather than a bar of
 * height zero, because "we do not know" and "it was none" are different
 * statements and only one of them is usually true.
 */
export function barChart(series: ChartSeries, options: ChartOptions = {}): Chart {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const format = options.format ?? defaultFormat;
  const unit = options.unit ?? 'units';
  const values = series.points.map((point) => point.value ?? 0);
  const ceiling = niceCeiling(Math.max(...values, 0));
  const innerWidth = width - PADDING.left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const step = innerWidth / Math.max(series.points.length, 1);
  const barWidth = Math.max(2, step * 0.62);

  const bars = series.points
    .map((point, index) => {
      const x = PADDING.left + step * (index + 0.5) - barWidth / 2;
      if (point.value === null) {
        return (
          `<text x="${round(x + barWidth / 2)}" y="${height - PADDING.bottom - 4}" ` +
          `text-anchor="middle" font-size="10" fill="var(--color-cms-muted)">n/a</text>`
        );
      }
      const barHeight = (point.value / ceiling) * innerHeight;
      const y = PADDING.top + innerHeight - barHeight;
      const rect =
        `<rect x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(barHeight)}" ` +
        `fill="var(--color-${series.token})" rx="2"><title>${escape(`${point.label}: ${format(point.value)}`)}</title></rect>`;
      return point.href === undefined ? rect : `<a href="${escape(point.href)}">${rect}</a>`;
    })
    .join('');

  return {
    svg:
      `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
      `aria-label="${escape(`${series.name}. ${altOf([series], unit, format)}`)}" ` +
      `preserveAspectRatio="xMidYMid meet">` +
      frame(width, height, ceiling, format) +
      bars +
      categoryLabels(
        series.points.map((point) => point.label),
        width,
        height,
      ) +
      referenceLine(options.reference, ceiling, width, height) +
      `</svg>`,
    alt: altOf([series], unit, format),
    table: tableOf([series], format),
  };
}

/**
 * A line chart, for a trend. A missing value breaks the line rather than
 * being interpolated across, so a gap in the data looks like a gap.
 */
export function lineChart(series: ChartSeries[], options: ChartOptions = {}): Chart {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const format = options.format ?? defaultFormat;
  const unit = options.unit ?? 'units';
  const all = series.flatMap((one) => one.points.map((point) => point.value ?? 0));
  const ceiling = niceCeiling(Math.max(...all, 0));
  const innerWidth = width - PADDING.left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const count = Math.max(series[0]?.points.length ?? 0, 1);
  const step = innerWidth / Math.max(count - 1, 1);
  // A dot on every point of a dense line is furniture: at thirty points the
  // markers merge into a thicker, noisier line and carry nothing the line did
  // not already say. Below the limit they are useful, because each one is a
  // readable value with its own hover title. Above it the line speaks for
  // itself and the numbers are in the table underneath, which is where an
  // exact value should be read anyway.
  const showMarkers = count <= MARKER_LIMIT;

  const paths = series
    .map((one) => {
      let path = '';
      let open = false;
      const marks: string[] = [];
      one.points.forEach((point, index) => {
        const x = PADDING.left + step * index;
        if (point.value === null) {
          open = false;
          return;
        }
        const y = PADDING.top + innerHeight * (1 - point.value / ceiling);
        path += `${open ? 'L' : 'M'}${round(x)} ${round(y)} `;
        open = true;
        if (showMarkers) {
          marks.push(
            `<circle cx="${round(x)}" cy="${round(y)}" r="2.5" fill="var(--color-${one.token})">` +
              `<title>${escape(`${one.name}, ${point.label}: ${format(point.value)}`)}</title></circle>`,
          );
        }
      });
      return (
        `<path d="${path.trim()}" fill="none" stroke="var(--color-${one.token})" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round" />` +
        marks.join('')
      );
    })
    .join('');

  return {
    svg:
      `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
      `aria-label="${escape(altOf(series, unit, format))}" preserveAspectRatio="xMidYMid meet">` +
      frame(width, height, ceiling, format) +
      paths +
      categoryLabels(
        (series[0]?.points ?? []).map((point) => point.label),
        width,
        height,
      ) +
      referenceLine(options.reference, ceiling, width, height) +
      `</svg>`,
    alt: altOf(series, unit, format),
    table: tableOf(series, format),
  };
}

/**
 * A stacked bar, for a composition that sums to a whole: where the elapsed
 * time went, or a funnel step by outcome. Stacking is only honest when the
 * parts genuinely add up, so the caller has to have made them do so.
 */
export function stackedBarChart(series: ChartSeries[], options: ChartOptions = {}): Chart {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const format = options.format ?? defaultFormat;
  const unit = options.unit ?? 'units';
  const count = series[0]?.points.length ?? 0;
  const totals = Array.from({ length: count }, (_unused, index) =>
    series.reduce((sum, one) => sum + (one.points[index]?.value ?? 0), 0),
  );
  const ceiling = niceCeiling(Math.max(...totals, 0));
  const innerWidth = width - PADDING.left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const step = innerWidth / Math.max(count, 1);
  const barWidth = Math.max(2, step * 0.62);

  let bars = '';
  for (let index = 0; index < count; index++) {
    let cursor = PADDING.top + innerHeight;
    for (const one of series) {
      const value = one.points[index]?.value ?? 0;
      if (value <= 0) continue;
      const barHeight = (value / ceiling) * innerHeight;
      cursor -= barHeight;
      const x = PADDING.left + step * (index + 0.5) - barWidth / 2;
      bars +=
        `<rect x="${round(x)}" y="${round(cursor)}" width="${round(barWidth)}" ` +
        `height="${round(barHeight)}" fill="var(--color-${one.token})">` +
        `<title>${escape(`${one.name}, ${one.points[index]?.label ?? ''}: ${format(value)}`)}</title></rect>`;
    }
  }

  return {
    svg:
      `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
      `aria-label="${escape(altOf(series, unit, format))}" preserveAspectRatio="xMidYMid meet">` +
      frame(width, height, ceiling, format) +
      bars +
      categoryLabels(
        (series[0]?.points ?? []).map((point) => point.label),
        width,
        height,
      ) +
      `</svg>`,
    alt: altOf(series, unit, format),
    table: tableOf(series, format),
  };
}

/**
 * A horizontal distribution, for age buckets and category counts. Horizontal
 * because the labels are words rather than dates and a vertical axis of
 * rotated words is unreadable.
 */
export function distributionChart(series: ChartSeries, options: ChartOptions = {}): Chart {
  const width = options.width ?? DEFAULT_WIDTH;
  const format = options.format ?? defaultFormat;
  const unit = options.unit ?? 'records';
  const rowHeight = 26;
  const height = Math.max(series.points.length * rowHeight + 16, 60);
  const labelWidth = 190;
  const trackWidth = width - labelWidth - 64;
  const ceiling = niceCeiling(Math.max(...series.points.map((point) => point.value ?? 0), 0));

  const rows = series.points
    .map((point, index) => {
      const y = index * rowHeight + 8;
      const value = point.value ?? 0;
      const barWidth = point.value === null ? 0 : (value / ceiling) * trackWidth;
      const bar =
        `<rect x="${labelWidth}" y="${y + 4}" width="${round(barWidth)}" height="${rowHeight - 12}" ` +
        `fill="var(--color-${series.token})" rx="2" />`;
      return (
        `<text x="${labelWidth - 10}" y="${y + rowHeight / 2 + 1}" text-anchor="end" font-size="12" ` +
        `fill="var(--color-cms-ink)">${escape(point.label)}</text>` +
        (point.href === undefined ? bar : `<a href="${escape(point.href)}">${bar}</a>`) +
        `<text x="${labelWidth + round(barWidth) + 8}" y="${y + rowHeight / 2 + 1}" font-size="12" ` +
        `fill="var(--color-cms-muted)">${escape(format(point.value))}</text>`
      );
    })
    .join('');

  return {
    svg:
      `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
      `aria-label="${escape(`${series.name}. ${altOf([series], unit, format)}`)}" ` +
      `preserveAspectRatio="xMidYMid meet">${rows}</svg>`,
    alt: altOf([series], unit, format),
    table: {
      columns: [series.name, 'Value'],
      rows: series.points.map((point) => [point.label, format(point.value)]),
    },
  };
}

/**
 * A stepped funnel: one bar per step, each as wide as its own count.
 *
 * DELIBERATELY NOT A TAPERING FUNNEL. The classic funnel shape encodes a
 * count as an area, and an area whose width and height both shrink falls off
 * far faster than the number does, so a step that keeps 70 per cent of the
 * previous one looks like it kept 40. Bars encode one number in one
 * dimension, which is the only honest way to read them.
 */
export function funnelChart(steps: ChartPoint[], options: ChartOptions = {}): Chart {
  const chart = distributionChart(
    { name: 'Funnel step', token: 'cms-series-1', points: steps },
    { ...options, unit: options.unit ?? 'records' },
  );
  const withRates = steps.map((step, index) => {
    const previous = index === 0 ? null : (steps[index - 1]?.value ?? null);
    const rate =
      previous === null || previous === 0 || step.value === null
        ? 'Not applicable'
        : `${Math.round(((step.value ?? 0) / previous) * 1000) / 10}%`;
    return [step.label, (options.format ?? defaultFormat)(step.value), rate];
  });
  return {
    ...chart,
    table: { columns: ['Step', 'Records', 'Conversion from previous step'], rows: withRates },
  };
}
