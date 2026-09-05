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
  /**
   * This point's own colour, overriding the series colour. A token name
   * without the `--color-` prefix, and always one of SERIES_TOKENS.
   *
   * ONE COLOUR PER BAR, ON A CHART WHOSE BARS ARE CATEGORIES. A trend line is
   * one measure over time and takes one colour; a bar chart of approval
   * functions is several categories side by side, and giving each its own
   * token is what lets the eye carry a function from the bar to the row in the
   * table beneath it. It is not decoration and it is never semantic: the
   * sequence is assigned by position, so nothing about the colour is a verdict
   * on the figure.
   */
  token?: string;
  /**
   * A second, lighter measure on the SAME row: the tail beside the middle.
   *
   * A median on its own flatters everybody. Drawing P90 as a marker on the bar
   * it belongs to puts the gap between them in one saccade, which is the
   * reading the page exists for. Horizontal bars only.
   */
  marker?: number | null;
  /**
   * This row's own target, drawn as a dashed rule across the row.
   *
   * Per point rather than per chart, because two approval functions do not
   * share a target and one line across the whole chart would be wrong for
   * every row but one. Absent where nothing is configured: no target, no line.
   */
  target?: number | null;
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
  /**
   * Write each series name at the end of its own line.
   *
   * A legend makes the reader hold a colour in their head and go looking for
   * it. A label at the end of the line is read where the eye already is, and
   * it survives greyscale, which a colour key does not.
   */
  endLabels?: boolean;
  /**
   * A labelled value axis with light gridlines, on a horizontal bar chart.
   *
   * WHY THIS EXISTS ONLY HERE, AND WHY `frame()` IS UNCHANGED. The vertical
   * charts deleted their gridlines deliberately (see `frame` below): the reader
   * of a trend is reading a shape, and the exact number is one disclosure away
   * in the data table. A horizontal bar chart of approval functions is a
   * different reading. Each row now carries TWO marks — the typical figure and
   * the slowest tenth — and the whole point of the chart is the DISTANCE
   * between them. A distance cannot be judged against nothing, so this chart
   * gets the scale the trend does not need. `frame()` still draws one baseline
   * and the doctrine it records still holds for the charts it serves.
   */
  valueAxis?: boolean;
  /**
   * A light wash under each line, in the line's own colour.
   *
   * It is a reading aid, not a quantity: the fill is far too faint to be read
   * as an area, which is what stops it claiming that the space under a median
   * means something. Two overlapping washes stay legible because each is a
   * tenth of an opacity.
   */
  area?: boolean;
  /**
   * What the category column is called in the data table.
   *
   * The default is `Period`, which is right for a trend and wrong for a set of
   * named categories. A chart of approval functions says `Function`, so the
   * table beneath it is readable on its own rather than only alongside the
   * picture it duplicates.
   */
  categoryName?: string;
  /**
   * What the second measure on each row is called, where one is drawn.
   *
   * AN SVG IS NOT THE DATA, THE TABLE IS. A chart that draws two marks per row
   * and tabulates one of them has not given a screen reader the same
   * information, it has given it less. Naming the marker here is what puts it
   * in the table.
   */
  markerName?: string;
  /**
   * What a chart with nothing to draw says in place of a plot.
   *
   * NEVER AN EMPTY FRAME IN SILENCE. A scale drawn over no data reads as a
   * measurement that came out at zero, which is a different claim from "there
   * were none", and only one of the two is usually true.
   */
  emptyMessage?: string;
  /**
   * The fewest categories that make a line, below which none is drawn.
   *
   * A LINE NEEDS TWO POINTS. One month of history plots one dot per series
   * against an axis of empty months, which reads as a scatter of outliers over
   * a period that mostly measured nothing — the opposite of what one good
   * month means. Below this count the chart states the shortfall instead, in
   * `emptyMessage`, and the values it does hold stay in the alt text and the
   * table underneath, so nothing measured is lost.
   */
  minimumCategories?: number;
  /**
   * What the two axes measure, drawn as titles beside their ticks.
   *
   * A TICK SAYS "37 min", A TITLE SAYS WHAT IS BEING MEASURED. Ticks alone
   * leave a reader to infer the dimension from the numbers, which is a guess on
   * every chart whose unit is not obvious. The titles are the smallest text on
   * the chart and sit outside the plot, so they name the axes without competing
   * with the data.
   */
  xAxisLabel?: string;
  yAxisLabel?: string;
}

/** Above this many points a line carries no markers. See lineChart. */
const MARKER_LIMIT = 14;

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 240;
const PADDING = { top: 16, right: 16, bottom: 34, left: 56 };
/** Extra room under the category ticks for an x-axis title. */
const X_TITLE_ROOM = 18;
/** Extra room above the plot for a y-axis title on its own line. */
const Y_TITLE_ROOM = 12;
/** The height a line chart takes when it has stood down and drawn no line. */
const EMPTY_HEIGHT = 56;

/**
 * How much room the value axis needs on the left: its widest tick label.
 *
 * PADDING.left was a fixed 56 pixels, which fits "50 min" and clips
 * "1 h 20 min" to "h 20 min". An axis whose units are cut off is not an axis,
 * and the sales order trend reads in hours. All three ticks are known before
 * anything is drawn, so the gutter is measured from them rather than guessed:
 * about six pixels a character at 11px, plus the eight-pixel gap the labels
 * already leave between themselves and the axis.
 */
function valueGutter(ceiling: number, format: (v: number | null) => string): number {
  const widest = Math.max(...[0, 0.5, 1].map((fraction) => format(ceiling * fraction).length));
  return Math.max(PADDING.left, Math.ceil(widest * 6.2) + 14);
}

/**
 * The two axis titles: the y title above its ticks, the x title under its own.
 *
 * The y title sits at the top-left rather than rotated up the side. A rotated
 * label is read by tilting the head or not at all, and at this size the unit is
 * two words; above the topmost tick it is read in the same pass as the tick.
 */
function axisTitles(
  options: ChartOptions,
  width: number,
  height: number,
  gutter = 0,
  left = PADDING.left,
): string {
  const y =
    options.yAxisLabel === undefined
      ? ''
      : `<text x="0" y="10" font-size="10" fill="var(--color-cms-muted)" ` +
        `letter-spacing="0.04em">${escape(options.yAxisLabel.toUpperCase())}</text>`;
  const x =
    options.xAxisLabel === undefined
      ? ''
      : `<text x="${round(left + (width - left - PADDING.right - gutter) / 2)}" ` +
        `y="${height - 4}" text-anchor="middle" font-size="10" ` +
        `fill="var(--color-cms-muted)" letter-spacing="0.04em">` +
        `${escape(options.xAxisLabel.toUpperCase())}</text>`;
  return y + x;
}

/**
 * The palette, in the order series are added. Tokens only, never a hex.
 *
 * SEVEN, BECAUSE THE PURCHASE ORDER TEMPLATE ALLOWS SEVEN APPROVAL LEVELS and
 * a chart of functions takes one colour per bar. Four levels are configured
 * today; a seventh configured next month draws in its own colour rather than
 * repeating one already on the same chart. Every value is measured against the
 * surface plane in test/cms/designSweep.test.ts.
 */
export const SERIES_TOKENS = [
  'cms-series-1',
  'cms-series-2',
  'cms-series-3',
  'cms-series-4',
  'cms-series-5',
  'cms-series-6',
  'cms-series-7',
] as const;

/**
 * The colour for the nth category on a chart.
 *
 * It wraps rather than running out, so an eighth level draws SOMETHING rather
 * than resolving to nothing and falling back to black, which is how a token
 * that Tailwind had tree-shaken took out every chart in the application once
 * already.
 */
export const seriesToken = (index: number): string => SERIES_TOKENS[index % SERIES_TOKENS.length]!;

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
  /** Room reserved on the right for end labels, so the baseline stops short. */
  gutter = 0,
  /** Room reserved on the left for the tick labels, measured from them. */
  left = PADDING.left,
): string {
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const baseY = PADDING.top + innerHeight;
  const labels = [0, 0.5, 1]
    .map((fraction) => {
      const y = PADDING.top + innerHeight * (1 - fraction);
      return (
        `<text x="${left - 8}" y="${round(y + 4)}" text-anchor="end" font-size="11" ` +
        `fill="var(--color-cms-muted)">${escape(format(ceiling * fraction))}</text>`
      );
    })
    .join('');
  return (
    `<line x1="${left}" y1="${round(baseY)}" x2="${width - PADDING.right - gutter}" ` +
    `y2="${round(baseY)}" stroke="var(--color-cms-line)" stroke-width="1" />` +
    labels
  );
}

function categoryLabels(
  labels: string[],
  width: number,
  height: number,
  gutter = 0,
  left = PADDING.left,
): string {
  const inner = width - left - PADDING.right - gutter;
  const step = inner / Math.max(labels.length, 1);
  // A label every nth category, so a year of weeks does not overprint itself.
  const stride = Math.max(1, Math.ceil(labels.length / 12));
  return labels
    .map((label, index) => {
      if (index % stride !== 0) return '';
      const x = left + step * (index + 0.5);
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
  gutter = 0,
  left = PADDING.left,
): string {
  if (reference === undefined) return '';
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const y = PADDING.top + innerHeight * (1 - Math.min(reference.value / ceiling, 1));
  return (
    `<line x1="${left}" y1="${round(y)}" x2="${width - PADDING.right - gutter}" y2="${round(y)}" ` +
    `stroke="var(--color-cms-ink-600)" stroke-width="1" stroke-dasharray="4 3" />` +
    `<text x="${width - PADDING.right - gutter}" y="${round(y - 5)}" text-anchor="end" font-size="11" ` +
    `fill="var(--color-cms-ink-600)">${escape(reference.label)}</text>`
  );
}

function tableOf(
  series: ChartSeries[],
  format: (v: number | null) => string,
  categoryName = 'Period',
): ChartTable {
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  return {
    columns: [categoryName, ...series.map((one) => one.name)],
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
  const left = valueGutter(ceiling, format);
  const innerWidth = width - left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const step = innerWidth / Math.max(series.points.length, 1);
  const barWidth = Math.max(2, step * 0.62);

  const bars = series.points
    .map((point, index) => {
      const x = left + step * (index + 0.5) - barWidth / 2;
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
      frame(width, height, ceiling, format, 0, left) +
      bars +
      categoryLabels(
        series.points.map((point) => point.label),
        width,
        height,
        0,
        left,
      ) +
      referenceLine(options.reference, ceiling, width, height, 0, left) +
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
  const left = valueGutter(ceiling, format);
  // The plot stops short of the x-axis title, so the two never overlap.
  const titleRoom = options.xAxisLabel === undefined ? 0 : X_TITLE_ROOM;
  const innerHeight = height - PADDING.top - PADDING.bottom - titleRoom;
  const count = Math.max(series[0]?.points.length ?? 0, 1);
  // A dot on every point of a dense line is furniture: at thirty points the
  // markers merge into a thicker, noisier line and carry nothing the line did
  // not already say. Below the limit they are useful, because each one is a
  // readable value with its own hover title. Above it the line speaks for
  // itself and the numbers are in the table underneath, which is where an
  // exact value should be read anyway.
  const showMarkers = count <= MARKER_LIMIT;
  // Room on the right for a name written at the end of its own line. Claimed
  // only when the caller asked for it, so a single-series chart keeps the
  // full plot width.
  // Wide enough for the LONGEST name actually on the chart, not for an average
  // one. "Country Manager Approval" clipped at a fixed 92 pixels and read as
  // "Country Manager Approva", which is a truncation the reader has to guess
  // past. Roughly six pixels per character at 11px, floored so a short name
  // does not give the plot away and capped so a long one does not eat it.
  const longest = Math.max(0, ...series.map((one) => one.name.length));
  const labelGutter =
    options.endLabels === true && series.length > 0
      ? Math.min(170, Math.max(92, longest * 6 + 14))
      : 0;
  const innerWidth = width - left - PADDING.right - labelGutter;
  const step = innerWidth / Math.max(count - 1, 1);

  const baseY = PADDING.top + innerHeight;
  const paths = series
    .map((one) => {
      let path = '';
      let open = false;
      const marks: string[] = [];
      // Each unbroken run of the line, so the wash under it stops where the
      // line stops. A single fill spanning a gap would shade a stretch the
      // series has no value for, which is the interpolation the line itself
      // refuses to draw.
      const runs: { x: number; y: number }[][] = [];
      let run: { x: number; y: number }[] = [];
      one.points.forEach((point, index) => {
        const x = left + step * index;
        if (point.value === null) {
          open = false;
          if (run.length > 0) runs.push(run);
          run = [];
          return;
        }
        const y = PADDING.top + innerHeight * (1 - point.value / ceiling);
        path += `${open ? 'L' : 'M'}${round(x)} ${round(y)} `;
        open = true;
        run.push({ x, y });
        if (showMarkers) {
          const dot =
            `<circle cx="${round(x)}" cy="${round(y)}" r="2.5" fill="var(--color-${one.token})">` +
            `<title>${escape(`${one.name}, ${point.label}: ${format(point.value)}`)}</title></circle>`;
          // A POINT OPENS ITS OWN BUCKET. An SVG anchor is focusable and takes
          // the page's focus ring, so the marker is a real target rather than a
          // hover affordance. Markers are drawn only below MARKER_LIMIT, so the
          // tab order can never grow past a readable number of them; above it
          // the same destinations are in the data table underneath, which is
          // where an exact value should be read anyway.
          marks.push(point.href === undefined ? dot : `<a href="${escape(point.href)}">${dot}</a>`);
        }
      });
      if (run.length > 0) runs.push(run);

      // ONE POINT IS A VALUE, NOT AN EMPTY CHART. A path with a single moveto
      // draws nothing, so a period that holds exactly one bucket would render
      // as a blank frame with an axis. The marker is already drawn above; this
      // prints the figure beside it, which is the honest rendering of "one
      // observation" and is what a reader came for.
      // A RUN OF ONE DRAWS NOTHING WITHOUT A MARKER, and above the marker limit
      // no marker is drawn at all — so a month whose neighbours hold no data
      // vanished and the trend read as a broken scatter. Every isolated run
      // gets its dot regardless of the limit, because one point is never the
      // dense line that limit exists to thin.
      const isolated = showMarkers
        ? ''
        : runs
            .filter((points) => points.length === 1)
            .map(
              (points) =>
                `<circle cx="${round(points[0]!.x)}" cy="${round(points[0]!.y)}" r="3" ` +
                `fill="var(--color-${one.token})" />`,
            )
            .join('');

      const measured = one.points.filter((point) => point.value !== null);
      const alone = measured.length === 1 && runs.length === 1 ? runs[0]![0]! : null;
      // A PATH WITH ONE MOVETO DRAWS NOTHING, so a period holding a single
      // bucket would render as a blank frame with an axis. The dot is drawn
      // whatever the marker limit says — one point is never a dense line — and
      // the figure is printed ABOVE it, where it cannot collide with the series
      // name written at the end of the same line.
      // THE VALUE IS SUPPRESSED WHERE THE SERIES NAME IS ALREADY THERE. With
      // end labels on, the name is written at that same point, and the two
      // texts landed on top of each other. The figure is one row away in the
      // data table, which is where an exact value should be read anyway.
      const single =
        alone === null || options.endLabels === true
          ? ''
          : `<text x="${round(alone.x)}" y="${round(alone.y - 7)}" text-anchor="middle" ` +
            `font-size="11" fill="var(--color-cms-ink)">` +
            `${escape(format(measured[0]!.value))}</text>`;
      // The dot is drawn whatever the labels do: a path with one moveto renders
      // nothing, so without it a period holding one month is a blank frame.
      const aloneDot =
        alone === null || showMarkers
          ? ''
          : `<circle cx="${round(alone.x)}" cy="${round(alone.y)}" r="3" ` +
            `fill="var(--color-${one.token})" />`;

      const wash =
        options.area !== true
          ? ''
          : runs
              .filter((points) => points.length > 1)
              .map((points) => {
                const first = points[0]!;
                const last = points[points.length - 1]!;
                const line = points.map((p) => `L${round(p.x)} ${round(p.y)}`).join(' ');
                return (
                  `<path d="M${round(first.x)} ${round(baseY)} ${line} ` +
                  `L${round(last.x)} ${round(baseY)} Z" fill="var(--color-${one.token})" ` +
                  `opacity="0.1" stroke="none" />`
                );
              })
              .join('');

      return (
        wash +
        `<path d="${path.trim()}" fill="none" stroke="var(--color-${one.token})" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round" />` +
        marks.join('') +
        isolated +
        aloneDot +
        single
      );
    })
    .join('');

  // The name of each series, written at the end of its own line.
  //
  // A legend is a lookup table: the reader holds a colour in their head,
  // travels to the key, and travels back. At the end of the line the name is
  // already where the eye finishes, and it still reads in greyscale and in
  // print, which a colour key does not.
  //
  // AND THEY MUST NOT OVERPRINT EACH OTHER. Four approval functions whose
  // medians are within a few minutes end their lines within a few pixels, and
  // four names drawn at those four heights render as one illegible smear —
  // which is exactly what a legend was supposed to avoid. So the labels are
  // placed at their true heights, then pushed apart to a minimum spacing in
  // order, which keeps every name beside its own line while guaranteeing each
  // one is readable.
  const placed = series
    .map((one) => {
      const last = [...one.points].reverse().find((point) => point.value !== null);
      if (last === undefined || last.value === null) return null;
      const index = one.points.lastIndexOf(last);
      return {
        name: one.name,
        token: one.token,
        x: left + step * index,
        y: PADDING.top + innerHeight * (1 - last.value / ceiling),
      };
    })
    .filter((one): one is { name: string; token: string; x: number; y: number } => one !== null)
    .sort((a, b) => a.y - b.y);
  const MIN_GAP = 13;
  for (let i = 1; i < placed.length; i += 1) {
    const above = placed[i - 1]!;
    const here = placed[i]!;
    if (here.y - above.y < MIN_GAP) here.y = above.y + MIN_GAP;
  }
  // If the stack ran past the plot, slide the whole column back up rather than
  // letting the last name fall off the bottom.
  const overshoot = (placed[placed.length - 1]?.y ?? 0) - (PADDING.top + innerHeight);
  if (overshoot > 0) for (const one of placed) one.y -= overshoot;

  const endLabels =
    labelGutter === 0
      ? ''
      : placed
          .map(
            (one) =>
              `<text x="${round(one.x + 8)}" y="${round(one.y + 4)}" font-size="11" ` +
              `fill="var(--color-${one.token})">${escape(one.name)}</text>`,
          )
          .join('');

  // NEVER AN EMPTY FRAME IN SILENCE. A frame and an axis drawn over no series
  // reads as a measurement that came out flat, which is a different claim from
  // "nothing was completed" and only one of them is usually true.
  const withValues = new Set(
    series.flatMap((one) =>
      one.points.filter((point) => point.value !== null).map((point) => point.label),
    ),
  );
  const tooShort = withValues.size < (options.minimumCategories ?? 0);
  const nothing =
    tooShort || series.every((one) => one.points.every((point) => point.value === null));
  // A PANEL THAT DREW NOTHING TAKES NO ROOM. Two hundred and forty pixels of
  // blank surface with six words in the middle of it reads as a chart that
  // failed to load; the same words on one short line read as a state.
  const drawn = nothing ? EMPTY_HEIGHT : height;
  const body = nothing
    ? `<text x="${left}" y="${round(EMPTY_HEIGHT / 2 + 4)}" font-size="12" ` +
      `fill="var(--color-cms-muted)">` +
      `${escape(options.emptyMessage ?? 'No values in this period.')}</text>`
    : frame(width, height - titleRoom, ceiling, format, labelGutter, left) +
      paths +
      categoryLabels(
        (series[0]?.points ?? []).map((point) => point.label),
        width,
        height - titleRoom,
        labelGutter,
        left,
      ) +
      referenceLine(options.reference, ceiling, width, height - titleRoom, labelGutter, left) +
      endLabels;
  const titles = nothing ? '' : axisTitles(options, width, height, labelGutter, left);
  // STANDING DOWN IS NOT LOSING THE NUMBERS. Where the line is withheld for
  // want of history, the reason is said first and the values that do exist are
  // still read out, because a screen reader gets no help from a picture that
  // decided not to draw itself.
  const stoodDown = options.emptyMessage ?? 'Not enough history';
  const described = tooShort
    ? `${/[.!?]$/.test(stoodDown) ? stoodDown : `${stoodDown}.`} ${altOf(series, unit, format)}`
    : altOf(series, unit, format);
  return {
    svg:
      `<svg viewBox="0 0 ${width} ${drawn}" width="100%" height="${drawn}" role="img" ` +
      `aria-label="${escape(described)}" preserveAspectRatio="xMidYMid meet">` +
      body +
      titles +
      `</svg>`,
    alt: described,
    table: tableOf(series, format, options.categoryName),
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
  const left = valueGutter(ceiling, format);
  const innerWidth = width - left - PADDING.right;
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
      const x = left + step * (index + 0.5) - barWidth / 2;
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
      frame(width, height, ceiling, format, 0, left) +
      bars +
      categoryLabels(
        (series[0]?.points ?? []).map((point) => point.label),
        width,
        height,
        0,
        left,
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

/**
 * A horizontal bar, for a ranked set of named categories.
 *
 * Vertical bars force a category name to be rotated, abbreviated or dropped
 * once there are more than about six of them. Horizontal bars give the name a
 * whole line to itself, so "Delivery delay at the depot" reads as words rather
 * than as a truncation, and the value sits at the end of its own bar where the
 * eye finishes rather than on an axis it has to travel back to.
 *
 * THE VALUE AXIS IS OPTIONAL AND OFF BY DEFAULT. Where a row carries one mark
 * the number printed at its end says everything an axis would, and an axis
 * would be a second way of saying it. Where a row carries the typical figure
 * AND the slowest tenth, the reading is the DISTANCE between them, and a
 * distance needs a scale: `valueAxis` turns on three labelled ticks and the two
 * light rules that go with them.
 */
export function horizontalBarChart(series: ChartSeries, options: ChartOptions = {}): Chart {
  const width = options.width ?? DEFAULT_WIDTH;
  const format = options.format ?? defaultFormat;
  const unit = options.unit ?? 'units';
  const labelWidth = Math.min(220, Math.round(width * 0.32));
  const valueWidth = 64;
  const rowHeight = 30;
  const barHeight = 14;
  const axis = options.valueAxis === true;
  // Room under the last row for the tick labels, claimed only when there are
  // tick labels to put there.
  const axisHeight = (axis ? 22 : 0) + (options.xAxisLabel === undefined ? 0 : X_TITLE_ROOM);
  const plotHeight =
    (options.height ?? series.points.length * rowHeight + 12) +
    (options.yAxisLabel === undefined ? 0 : Y_TITLE_ROOM);
  const height = plotHeight + axisHeight;
  const trackWidth = width - labelWidth - valueWidth - 16;
  // THE SCALE MUST HOLD EVERY MARK, not only the bars. A P90 marker or a
  // target sitting past the frame would be drawn outside the chart, which is
  // how a tail becomes invisible at exactly the moment it matters.
  const ceiling = niceCeiling(
    Math.max(...series.points.map((p) => Math.max(p.value ?? 0, p.marker ?? 0, p.target ?? 0)), 0),
  );
  const at = (v: number): number => labelWidth + 8 + (v / ceiling) * trackWidth;

  /**
   * The scale: three ticks, two light rules, drawn BEFORE the bars.
   *
   * Behind rather than in front, so a rule never crosses a bar it is there to
   * help measure. The zero rule is the axis itself and is drawn in the divider
   * tone; the two in between are the gridlines. The labels use the chart's own
   * formatter, so the axis reads "2 d 23 h" rather than "4260".
   */
  const scale = !axis
    ? ''
    : [0, 0.5, 1]
        .map((fraction) => {
          const x = at(ceiling * fraction);
          const rule =
            `<line x1="${round(x)}" y1="0" x2="${round(x)}" y2="${round(plotHeight)}" ` +
            `stroke="var(--color-cms-line)" stroke-width="1" />`;
          const anchor = fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle';
          const text =
            `<text x="${round(x)}" y="${round(plotHeight + 14)}" text-anchor="${anchor}" ` +
            `font-size="11" fill="var(--color-cms-muted)">` +
            `${escape(format(ceiling * fraction))}</text>`;
          return rule + text;
        })
        .join('');

  // THE TITLE OWNS THE TOP LINE. Without this the first category label was
  // drawn at the same height as the y-axis title and the two overprinted.
  const rowTop = options.yAxisLabel === undefined ? 6 : 6 + Y_TITLE_ROOM;
  const rows = series.points
    .map((point, index) => {
      const y = rowTop + index * rowHeight;
      // ONE COLOUR PER BAR where the caller assigned one, the series colour
      // where it did not, so a single-measure chart is unchanged.
      const token = point.token ?? series.token;
      const label =
        `<text x="0" y="${round(y + barHeight)}" font-size="12" ` +
        `fill="var(--color-cms-ink)">${escape(point.label)}</text>`;
      if (point.value === null) {
        return (
          label +
          `<text x="${labelWidth + 8}" y="${round(y + barHeight)}" font-size="11" ` +
          `fill="var(--color-cms-muted)">Not available</text>`
        );
      }
      const barWidth = Math.max(1, (point.value / ceiling) * trackWidth);
      const bar =
        `<rect x="${labelWidth + 8}" y="${round(y + 3)}" width="${round(barWidth)}" ` +
        `height="${barHeight}" rx="2" fill="var(--color-${token})">` +
        `<title>${escape(`${point.label}: ${format(point.value)}`)}</title></rect>`;

      // THE TAIL, ON THE SAME ROW AS THE MIDDLE, AND THIS IS THE MOST USEFUL
      // MARK ON THE PAGE.
      //
      // Level 1 of the purchase order process has a typical time of 21 minutes
      // and a slowest tenth of 2,586. Read the typical alone and it is the
      // fastest level in the process; read both and it is the worst. So the
      // tail is drawn as a CONTINUATION of the same bar in the same colour at a
      // tenth of the weight, closed by a solid tick — not as a second bar,
      // because two bars on a row read as two categories and this is one
      // category measured twice. The pale run between the two is the gap, and
      // its length is the whole argument.
      const tail =
        point.marker === null || point.marker === undefined || point.marker <= point.value
          ? ''
          : `<rect x="${round(at(point.value))}" y="${round(y + 3)}" ` +
            `width="${round(Math.max(1, at(point.marker) - at(point.value)))}" ` +
            `height="${barHeight}" rx="2" fill="var(--color-${token})" opacity="0.22" />`;
      const marker =
        point.marker === null || point.marker === undefined
          ? ''
          : `<rect x="${round(at(point.marker) - 1)}" y="${round(y)}" width="2" ` +
            `height="${barHeight + 6}" rx="1" fill="var(--color-${token})" ` +
            `opacity="0.6"><title>${escape(
              `${point.label}, slowest 10%: ${format(point.marker)}`,
            )}</title></rect>`;

      // The target, dashed, so it is never mistaken for a measurement. Drawn
      // only where a target is configured for THIS function: no target, no
      // line, and never a line against an invented number.
      const target =
        point.target === null || point.target === undefined
          ? ''
          : `<line x1="${round(at(point.target))}" y1="${round(y)}" ` +
            `x2="${round(at(point.target))}" y2="${round(y + barHeight + 6)}" ` +
            `stroke="var(--color-cms-ink-600)" stroke-width="1.5" stroke-dasharray="3 2">` +
            `<title>${escape(`${point.label}, target: ${format(point.target)}`)}</title></line>`;

      const furthest = Math.max(point.value, point.marker ?? 0);
      const value =
        `<text x="${round(at(furthest) + 8)}" y="${round(y + barHeight)}" ` +
        `font-size="11" fill="var(--color-cms-muted)">${escape(format(point.value))}</text>`;
      const drawn = point.href === undefined ? bar : `<a href="${escape(point.href)}">${bar}</a>`;
      return label + tail + drawn + marker + target + value;
    })
    .join('');

  const alt = categoryAlt(series, unit, format, options.markerName);
  // AN EMPTY CHART NEVER DRAWS A SCALE. With no categories the ceiling falls
  // back to one and the axis prints "0, 1, 1" under an empty plot, which reads
  // as a measurement of nothing rather than as an absence. The frame is dropped
  // and the absence is stated instead.
  const body =
    series.points.length === 0
      ? `<text x="0" y="${round(plotHeight / 2)}" font-size="12" ` +
        `fill="var(--color-cms-muted)">` +
        `${escape(options.emptyMessage ?? 'No values in this period.')}</text>`
      : `${scale}${rows}`;
  return {
    svg:
      `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
      `aria-label="${escape(`${series.name}. ${alt}`)}" ` +
      `preserveAspectRatio="xMinYMin meet">${body}${
        series.points.length === 0 ? '' : axisTitles(options, width, height)
      }</svg>`,
    alt,
    table: categoryTable(series, format, options),
  };
}

/**
 * The horizontal bar chart's own table: every mark the picture draws.
 *
 * The marker and the target columns appear only where the chart drew them, so
 * a table never carries a column of "Not available" for something the chart
 * never claimed to show.
 */
function categoryTable(
  series: ChartSeries,
  format: (v: number | null) => string,
  options: ChartOptions,
): ChartTable {
  const hasMarker = series.points.some((p) => p.marker !== null && p.marker !== undefined);
  const hasTarget = series.points.some((p) => p.target !== null && p.target !== undefined);
  const columns = [options.categoryName ?? 'Category', series.name];
  if (hasMarker) columns.push(options.markerName ?? 'Second measure');
  if (hasTarget) columns.push('Target');
  return {
    columns,
    rows: series.points.map((point) => {
      const cells = [point.label, format(point.value)];
      if (hasMarker) cells.push(format(point.marker ?? null));
      if (hasTarget) cells.push(format(point.target ?? null));
      return cells;
    }),
  };
}

/**
 * The sentence a screen reader hears in place of a chart of NAMED CATEGORIES.
 *
 * `altOf` describes a series as a journey — from the first point to the last,
 * with a peak — which is the right reading of a trend and the wrong reading of
 * four approval functions, where there is no order in time and "from finance
 * approval to loading authority" states a progression that does not exist.
 * This one reads the categories out with both of their marks, slowest first,
 * because the ranking is the information.
 */
function categoryAlt(
  series: ChartSeries,
  unit: string,
  format: (v: number | null) => string,
  markerName: string | undefined,
): string {
  const measured = series.points.filter((point) => point.value !== null);
  if (measured.length === 0) return `${series.name}: no values available.`;
  const ranked = [...measured].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const parts = ranked.map((point) => {
    const marker =
      point.marker === null || point.marker === undefined
        ? ''
        : `, ${(markerName ?? 'second measure').toLowerCase()} ${format(point.marker)}`;
    return `${point.label} ${format(point.value)}${marker}`;
  });
  return (
    `${series.name}, in ${unit}, ${measured.length} ` +
    `${measured.length === 1 ? 'category' : 'categories'} highest first: ${parts.join('; ')}.`
  );
}

/**
 * A sparkline: the shape of a trend, at the size of a line of text.
 *
 * It belongs inside a KPI card, where the figure is the answer and the
 * direction is the context. There is no axis, no label and no marker except
 * the last point, because at this size any of them would be noise rather than
 * information. The numbers are still reachable: the card carries the same
 * table every other chart does.
 */
export function sparkline(series: ChartSeries, options: ChartOptions = {}): Chart {
  const width = options.width ?? 120;
  const height = options.height ?? 28;
  const format = options.format ?? defaultFormat;
  const unit = options.unit ?? 'units';
  const values = series.points.map((point) => point.value).filter((v): v is number => v !== null);
  const top = Math.max(...values, 0);
  const floor = Math.min(...values, 0);
  const span = top - floor || 1;
  const step = width / Math.max(series.points.length - 1, 1);

  let path = '';
  let open = false;
  let lastX = 0;
  let lastY = 0;
  series.points.forEach((point, index) => {
    if (point.value === null) {
      open = false;
      return;
    }
    const x = step * index;
    const y = height - 2 - ((point.value - floor) / span) * (height - 4);
    path += `${open ? 'L' : 'M'}${round(x)} ${round(y)} `;
    open = true;
    lastX = x;
    lastY = y;
  });

  return {
    svg:
      `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" ` +
      `aria-label="${escape(altOf([series], unit, format))}" preserveAspectRatio="none">` +
      `<path d="${path.trim()}" fill="none" stroke="var(--color-${series.token})" ` +
      `stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />` +
      (values.length > 0
        ? `<circle cx="${round(lastX)}" cy="${round(lastY)}" r="2" fill="var(--color-${series.token})" />`
        : '') +
      `</svg>`,
    alt: altOf([series], unit, format),
    table: tableOf([series], format),
  };
}
