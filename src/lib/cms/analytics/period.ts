/**
 * The period, chosen once and understood everywhere.
 *
 * WHAT THIS REPLACES. Two `dd/mm/yyyy` boxes and a Trend dropdown. That panel
 * asked a person to type a date twice before they saw anything, and it put a
 * grain in front of them that the period they had just chosen already answers.
 * A month wants days, a year wants months, a day wants hours; nobody has ever
 * wanted a year of daily marks, and the one case that genuinely does is behind
 * Custom rather than in front of everybody.
 *
 * IT LIVES IN THE URL, AS ONE TOKEN. `?period=2026-05` is a month,
 * `?period=2026` is a year, `?period=2026-05-14` is a day, `?period=this-month`
 * is a preset that follows the calendar rather than freezing a date, and
 * `?period=custom&from=…&to=…` is the escape hatch. One token means a view can
 * be sent to somebody else and arrive as the same view, and it means a
 * drill-down carries its period without the destination having to reconstruct
 * one.
 *
 * THE DEFAULT MUST NEVER SHOW A BLANK PAGE. The current period is the right
 * default and it is not always the right answer: this database holds one
 * extract covering 30 April to 30 May 2026, so on 30 August 2026 the current
 * month is genuinely empty and stays empty until the next extract lands. A
 * dashboard that renders an empty chart while the data sits three months back,
 * and says nothing, is a working system that looks broken. So the resolution
 * below has two steps: choose the current period, and where it holds nothing
 * while another period holds something, move to the most recent period that
 * does and SAY SO, with a control to go back.
 *
 * WHAT IT DOES NOT DO. It never widens what a caller may see. The scope
 * resolver decides that on every query; a period only narrows what the scope
 * already allows.
 */

/** The bucket size a chart draws, derived from the span and never chosen. */
export const PERIOD_GRAINS = ['HOUR', 'DAY', 'MONTH'] as const;
export type PeriodGrain = (typeof PERIOD_GRAINS)[number];

export const PRESET_KEYS = [
  'this-month',
  'last-month',
  'this-quarter',
  'this-year',
  'last-year',
  'all',
  'custom',
] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

/** The presets, in the order they are offered. Custom is last for a reason. */
export const PRESETS: readonly { readonly key: PresetKey; readonly label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'this-year', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

/** What a period resolves to. Every consumer reads this and nothing else. */
export interface ResolvedPeriod {
  /** The URL token. `custom` carries its ends in `from` and `to`. */
  readonly key: string;
  /** Inclusive floor, "YYYY-MM-DD". Null only for all time. */
  readonly from: string | null;
  /** Inclusive ceiling, "YYYY-MM-DD". Null only for all time. */
  readonly to: string | null;
  /** What the page prints so nobody opens the control to find out. */
  readonly label: string;
  /** Derived from the span. Never chosen. */
  readonly grain: PeriodGrain;
  /** Which preset produced this, where one did. */
  readonly preset: PresetKey | null;
  /** Whether the token named a year, a month or a day in the drill. */
  readonly level: 'YEAR' | 'MONTH' | 'DAY' | 'RANGE' | 'ALL';
}

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

const YEAR_TOKEN = /^\d{4}$/;
const MONTH_TOKEN = /^\d{4}-\d{2}$/;
const DAY_TOKEN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dates are handled in UTC throughout.
 *
 * Not because the business is in UTC — it is in Nairobi — but because the only
 * arithmetic here is calendar arithmetic on whole days, and doing it in the
 * server's local zone makes the boundary of "this month" depend on where the
 * worker happens to be scheduled. The database stores naked "YYYY-MM-DD
 * HH:MM:SS" strings with no zone at all, so a UTC calendar and a string
 * comparison agree by construction.
 */
const ymd = (date: Date): string => date.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d));

/** The last day of a month, without a date library. Day 0 of the next month. */
const endOfMonth = (y: number, m: number): Date => utc(y, m + 1, 0);

const partsOf = (token: string): { y: number; m: number; d: number } => ({
  y: Number(token.slice(0, 4)),
  m: Number(token.slice(5, 7)) - 1,
  d: Number(token.slice(8, 10)),
});

/** Days between two inclusive ends, counting both. */
export function spanDays(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * The grain, from the span alone.
 *
 * A day shows hours, a month shows days, a year shows months, and a quarter
 * shows days because ninety marks is a readable line and three bars is not.
 * All time shows months: it is the only span whose length is unknown until the
 * data is read, and months is the answer that stays readable at any length.
 */
export function grainFor(from: string | null, to: string | null): PeriodGrain {
  const days = spanDays(from, to);
  if (days === null) return 'MONTH';
  if (days <= 1) return 'HOUR';
  if (days <= 92) return 'DAY';
  return 'MONTH';
}

const label = (level: ResolvedPeriod['level'], from: string | null, to: string | null): string => {
  if (level === 'ALL' || from === null || to === null) return 'All time';
  const a = partsOf(from);
  if (level === 'YEAR') return String(a.y);
  if (level === 'MONTH') return `${MONTH_NAMES[a.m]} ${a.y}`;
  if (level === 'DAY') return `${a.d} ${MONTH_NAMES[a.m]} ${a.y}`;
  const b = partsOf(to);
  return `${a.d} ${MONTH_NAMES[a.m]} ${a.y} to ${b.d} ${MONTH_NAMES[b.m]} ${b.y}`;
};

function build(
  key: string,
  level: ResolvedPeriod['level'],
  from: string | null,
  to: string | null,
  preset: PresetKey | null,
  labelOverride?: string,
): ResolvedPeriod {
  return {
    key,
    from,
    to,
    label: labelOverride ?? label(level, from, to),
    grain: grainFor(from, to),
    preset,
    level,
  };
}

/** The period a bare token names, with no calendar knowledge. */
export function periodFromToken(token: string, today: Date): ResolvedPeriod | null {
  if (YEAR_TOKEN.test(token)) {
    const y = Number(token);
    if (y < 1970 || y > 9999) return null;
    return build(token, 'YEAR', ymd(utc(y, 0, 1)), ymd(utc(y, 11, 31)), null);
  }
  if (MONTH_TOKEN.test(token)) {
    const { y, m } = partsOf(token);
    if (m < 0 || m > 11) return null;
    return build(token, 'MONTH', ymd(utc(y, m, 1)), ymd(endOfMonth(y, m)), null);
  }
  if (DAY_TOKEN.test(token)) {
    const { y, m, d } = partsOf(token);
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    const day = ymd(utc(y, m, d));
    return build(token, 'DAY', day, day, null);
  }
  return presetPeriod(token as PresetKey, today);
}

/** The period a preset names on a given day. */
export function presetPeriod(key: PresetKey, today: Date): ResolvedPeriod | null {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (key) {
    case 'this-month':
      return build('this-month', 'MONTH', ymd(utc(y, m, 1)), ymd(endOfMonth(y, m)), 'this-month');
    case 'last-month': {
      const d = utc(y, m - 1, 1);
      return build(
        'last-month',
        'MONTH',
        ymd(d),
        ymd(endOfMonth(d.getUTCFullYear(), d.getUTCMonth())),
        'last-month',
      );
    }
    case 'this-quarter': {
      const start = Math.floor(m / 3) * 3;
      return build(
        'this-quarter',
        'RANGE',
        ymd(utc(y, start, 1)),
        ymd(endOfMonth(y, start + 2)),
        'this-quarter',
        `Q${start / 3 + 1} ${y}`,
      );
    }
    case 'this-year':
      return build('this-year', 'YEAR', ymd(utc(y, 0, 1)), ymd(utc(y, 11, 31)), 'this-year');
    case 'last-year':
      return build(
        'last-year',
        'YEAR',
        ymd(utc(y - 1, 0, 1)),
        ymd(utc(y - 1, 11, 31)),
        'last-year',
      );
    case 'all':
      return build('all', 'ALL', null, null, 'all');
    default:
      return null;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The period this request asked for, or the current month when it asked for
 * nothing.
 *
 * A malformed token is treated as absent rather than as an error: a truncated
 * link should show a person the default view, not a stack trace.
 */
export function parsePeriod(params: URLSearchParams, today: Date): ResolvedPeriod {
  const raw = (params.get('period') ?? '').trim();
  if (raw === 'custom') {
    const from = (params.get('from') ?? '').trim();
    const to = (params.get('to') ?? '').trim();
    if (DATE.test(from) && DATE.test(to)) {
      // A reversed range is a typing mistake, not a query.
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return build('custom', 'RANGE', lo, hi, 'custom');
    }
    if (DATE.test(from)) return build('custom', 'RANGE', from, from, 'custom');
  }
  if (raw !== '') {
    const found = periodFromToken(raw, today);
    if (found !== null) return found;
  }
  return presetPeriod('this-month', today) as ResolvedPeriod;
}

/**
 * The previous equivalent period: this month against last month, this year
 * against last year, this day against yesterday.
 *
 * The comparison follows the selection rather than being chosen separately,
 * because a comparison against a period nobody selected is a number nobody can
 * check. All time has no previous, and says so by returning null.
 */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod | null {
  if (period.from === null || period.to === null) return null;
  const a = partsOf(period.from);
  if (period.level === 'YEAR') return periodFromToken(String(a.y - 1), new Date(0));
  if (period.level === 'MONTH') {
    const d = utc(a.y, a.m - 1, 1);
    return periodFromToken(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      new Date(0),
    );
  }
  if (period.level === 'DAY') {
    const d = new Date(Date.parse(`${period.from}T00:00:00Z`) - 86400000);
    return periodFromToken(ymd(d), new Date(0));
  }
  // A QUARTER COMPARES WITH THE CALENDAR QUARTER BEFORE IT, not with the
  // ninety-two days before it. Those differ by a day or two and the difference
  // is not academic: a comparison against "the 92 days ending 30 June" is a
  // span nobody named and nobody can look up, while Q2 is a period the business
  // closes its books on.
  if (period.preset === 'this-quarter') {
    const start = a.m - 3;
    const d = utc(a.y, start, 1);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return build(
      'custom',
      'RANGE',
      ymd(utc(y, m, 1)),
      ymd(endOfMonth(y, m + 2)),
      null,
      `Q${Math.floor(m / 3) + 1} ${y}`,
    );
  }
  // Any other range shifts back by its own length, so a custom fortnight
  // compares with the fortnight before it.
  const days = spanDays(period.from, period.to) ?? 1;
  const to = new Date(Date.parse(`${period.from}T00:00:00Z`) - 86400000);
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return build('custom', 'RANGE', ymd(from), ymd(to), null);
}

/** The period as query parameters, so a drill-down carries what it came from. */
export function periodParams(period: ResolvedPeriod): Record<string, string> {
  if (period.key !== 'custom') return { period: period.key };
  return { period: 'custom', from: period.from ?? '', to: period.to ?? '' };
}

/** A link to the same page at a different period, keeping everything else. */
export function periodHref(
  path: string,
  period: ResolvedPeriod,
  extra: Record<string, string | null> = {},
): string {
  const params = new URLSearchParams(periodParams(period));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== null && value !== '') params.set(key, value);
  }
  const rendered = params.toString();
  return rendered === '' ? path : `${path}?${rendered}`;
}

/**
 * The date window as SQL, against whichever column carries the metric's basis.
 *
 * The basis is named by the caller and never assumed: an order created in June
 * and approved in July belongs to different periods depending on the question.
 * The ends are inclusive whole days, which is what a person means by "May".
 */
export function periodWindow(
  column: string,
  period: ResolvedPeriod,
): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  if (period.from !== null) {
    parts.push(`${column} >= ?`);
    args.push(`${period.from} 00:00:00`);
  }
  if (period.to !== null) {
    parts.push(`${column} <= ?`);
    args.push(`${period.to} 23:59:59`);
  }
  return { sql: parts.length === 0 ? '1 = 1' : parts.join(' AND '), args };
}

/** The trend bucket expression for a grain, in SQLite's own strftime. */
export function bucketFor(column: string, grain: PeriodGrain): string {
  if (grain === 'HOUR') return `strftime('%Y-%m-%d %H:00', ${column})`;
  if (grain === 'DAY') return `strftime('%Y-%m-%d', ${column})`;
  return `strftime('%Y-%m', ${column})`;
}

/** The twelve months a Home trend covers, ending at the month on screen. */
export const TREND_MONTHS = 12;

/**
 * A window of whole months ending at the month a period names.
 *
 * WHY A TREND HAS ITS OWN WINDOW. The panels answer "what happened in May";
 * a trend answers "is May better or worse than the months before it", and that
 * second question cannot be asked of May alone. So the bars and the table read
 * the selected month while the line beside them reads the year ending at it —
 * one plotted value per month, which is what makes it a trend rather than a
 * scatter of the days inside one month.
 *
 * The window is whole months on both ends, so every bucket the line draws is a
 * complete month except the one still running.
 */
export function trailingMonths(period: ResolvedPeriod, count = TREND_MONTHS): ResolvedPeriod {
  if (count < 1) return period;
  const anchor = period.to ?? period.from;
  if (anchor === null) return period;
  const { y, m } = partsOf(anchor);
  const first = utc(y, m - (count - 1), 1);
  const window = build(
    'custom',
    'RANGE',
    ymd(first),
    ymd(endOfMonth(y, m)),
    null,
    `${SHORT_MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()} to ${MONTH_NAMES[m]} ${y}`,
  );
  // THE GRAIN IS MONTHS BECAUSE THE BUCKETS ARE MONTHS, not because the span
  // says so. `grainFor` reads a two-month window as sixty-one days and would
  // have `periodBuckets` enumerate every one of them — sixty-one daily keys
  // against a query that returned two monthly ones, so nothing matched and the
  // whole trend rendered as "no data" while the rows sat in hand.
  return { ...window, grain: 'MONTH' };
}

/**
 * How many months a trend should span, given what the data actually covers.
 *
 * A FIXED YEAR OF BUCKETS IS A YEAR OF EMPTY ONES ON A YOUNG DATASET. This
 * database holds one extract covering two months, so a twelve-month axis drew
 * ten blank columns and squeezed the whole line into the last inch of the
 * chart — which is exactly the clustered-dots reading a trend is supposed to
 * replace. The window therefore starts at the earliest month that holds
 * anything, never earlier, and never spans more than a year.
 *
 * Two is the floor rather than one: a single column is a bar, not a trend, and
 * a second column is what makes the axis read as time.
 */
export function trendSpan(
  period: ResolvedPeriod,
  calendar: DataCalendar,
  limit = TREND_MONTHS,
): number {
  const anchor = period.to ?? period.from;
  const earliest = [...calendar.months].sort()[0];
  if (anchor === undefined || anchor === null || earliest === undefined) return limit;
  const end = partsOf(anchor);
  const start = partsOf(`${earliest}-01`);
  const months = (end.y - start.y) * 12 + (end.m - start.m) + 1;
  return Math.min(limit, Math.max(2, months));
}

/**
 * The month a Home period sits in, as the two values its control holds.
 *
 * A dashboard period is a MONTH and nothing else, so it is addressed the way a
 * person says it: a month and a year. Anything the URL carries that is not a
 * month — a quarter, a year, all time, a typed range — resolves to the month
 * its window ends in, so a link from elsewhere in the application still lands
 * somewhere the control can express.
 */
export function monthOf(period: ResolvedPeriod, today: Date): { month: number; year: number } {
  const anchor = period.to ?? period.from;
  if (anchor === null) return { month: today.getUTCMonth() + 1, year: today.getUTCFullYear() };
  const { y, m } = partsOf(anchor);
  return { month: m + 1, year: y };
}

/**
 * The month a dashboard is showing, from either shape of URL.
 *
 * TWO SHAPES REACH THIS PAGE AND BOTH HAVE TO WORK. The control submits
 * `?month=5&year=2026`, because that is what two dropdowns post; every drill
 * destination and every link from elsewhere in the application carries
 * `?period=2026-05`, because that is the one token the rest of the system
 * speaks. Reading both here is what lets the dashboard use dropdowns without
 * the rest of the application having to learn a second vocabulary.
 *
 * The answer is always a WHOLE MONTH. A link carrying a quarter, a year or all
 * time resolves to the month its window ends in, so a period the control cannot
 * express can still be arrived at and is shown as something it can.
 */
export function parseDashboardPeriod(
  params: URLSearchParams,
  today: Date,
): { period: ResolvedPeriod; chosen: boolean } {
  const month = Number(params.get('month'));
  const year = Number(params.get('year'));
  if (
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(year) &&
    year >= 1970 &&
    year <= 9999
  ) {
    const named = periodFromToken(monthToken(month, year), today);
    if (named !== null) return { period: named, chosen: true };
  }
  const asked = parsePeriod(params, today);
  const chosen = periodWasChosen(params);
  if (asked.level === 'MONTH') return { period: asked, chosen };
  const at = monthOf(asked, today);
  const normalised = periodFromToken(monthToken(at.month, at.year), today);
  return { period: normalised ?? asked, chosen };
}

/** The period token a month and a year name: `YYYY-MM`. */
export function monthToken(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The twelve month names, for the control's own dropdown. */
export const MONTH_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  MONTH_NAMES.map((name, index) => ({ value: String(index + 1), label: name }));

/**
 * The years the year dropdown offers: every year the data touches, plus the
 * current one, newest first.
 *
 * Read from the calendar rather than from a range somebody typed, so the
 * control cannot offer a year that holds nothing and cannot hide one that does.
 */
export function yearOptions(
  calendar: DataCalendar,
  today: Date,
  selected: number,
): { value: string; label: string }[] {
  const years = new Set<string>(calendar.years);
  years.add(String(today.getUTCFullYear()));
  years.add(String(selected));
  return [...years]
    .sort((a, b) => b.localeCompare(a))
    .map((year) => ({ value: year, label: year }));
}

/** One bucket of a trend: its key in the data, its label, and where it drills. */
export interface PeriodBucket {
  /** Matches `bucketFor`'s output exactly, so a row can be looked up by it. */
  readonly key: string;
  /** What the axis prints. */
  readonly label: string;
  /**
   * The period token this bucket drills to.
   *
   * An hour has no token — `periodFromToken` reads years, months and days —
   * so an hourly bucket drills to the day that contains it. That is the
   * narrowest period the URL can actually name, and naming a period the
   * destination cannot resolve would land the reader on a different population
   * from the one they clicked.
   */
  readonly token: string;
}

const SHORT_MONTHS = MONTH_NAMES.map((name) => name.slice(0, 3));

/**
 * Every bucket the period covers, in order, whether or not it holds data.
 *
 * A TREND MUST SHOW ITS GAPS. Plotting only the buckets that returned rows
 * compresses a quiet fortnight into the space of a day and draws a line that
 * says the work was continuous. Enumerating the period instead means a day
 * with no approvals is a break in the line rather than a shortcut across it,
 * which is why the caller fills a missing bucket with null and never with
 * zero: "nothing was approved" and "an approval took no time" are different
 * statements.
 *
 * Returns null for all time, whose length is unknown until the data is read.
 * There the caller has no choice but to plot the buckets that exist.
 */
export function periodBuckets(period: ResolvedPeriod): PeriodBucket[] | null {
  if (period.from === null || period.to === null) return null;
  const out: PeriodBucket[] = [];
  if (period.grain === 'HOUR') {
    const day = period.from;
    for (let h = 0; h < 24; h += 1) {
      const hh = String(h).padStart(2, '0');
      out.push({ key: `${day} ${hh}:00`, label: `${hh}:00`, token: day });
    }
    return out;
  }
  const start = partsOf(period.from);
  const end = partsOf(period.to);
  if (period.grain === 'DAY') {
    // A span inside one month labels by day number alone; one that crosses a
    // month has to say which month, or 1 reads as the same mark twice.
    const oneMonth = period.from.slice(0, 7) === period.to.slice(0, 7);
    for (
      let cursor = utc(start.y, start.m, start.d);
      ymd(cursor) <= period.to;
      cursor = utc(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1)
    ) {
      const key = ymd(cursor);
      out.push({
        key,
        label: oneMonth
          ? String(cursor.getUTCDate())
          : `${cursor.getUTCDate()} ${SHORT_MONTHS[cursor.getUTCMonth()]}`,
        token: key,
      });
    }
    return out;
  }
  // A WINDOW OF A YEAR OR LESS NAMES THE MONTH ALONE. Inside twelve months no
  // month repeats, so "Jan" is unambiguous, and twelve "Jan 2026"-style labels
  // overprint each other on a half-width panel. Only a longer window, where a
  // month can appear twice, has to carry its year.
  const months = (end.y - start.y) * 12 + (end.m - start.m) + 1;
  for (let y = start.y, m = start.m; y < end.y || (y === end.y && m <= end.m); ) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    out.push({
      key,
      label: months <= 12 ? SHORT_MONTHS[m]! : `${SHORT_MONTHS[m]} ${y}`,
      token: key,
    });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
 * WHICH PERIODS HOLD DATA
 * ------------------------------------------------------------------------- */

/** One date column that counts as activity for this page. */
export interface CalendarSource {
  readonly table: string;
  readonly column: string;
  /** An optional extra restriction, already safe: no caller input reaches it. */
  readonly where?: string;
  /**
   * WHICH PANEL THIS ACTIVITY BELONGS TO, AND WHY IT HAD TO EXIST.
   *
   * Home draws two boards from one period. The calendar behind the period
   * control used to union every source into one population, so "does this
   * period hold data" was answered for the PAGE. That is the wrong question,
   * and it produced the exact failure this field fixes: on 30 August 2026 the
   * calendar saw a lead and a sales order completed in August, answered "yes,
   * August has data", and the fallback never fired — while the purchase order
   * board, whose data ran 1 to 30 May, rendered an empty chart and an empty
   * table in silence.
   *
   * A series labels each source so the same single statement answers the
   * question per board as well as for the page. The period is still resolved
   * ONCE, from the combined calendar; each panel then knows whether ITS own
   * data is in that period, and says so when it is not.
   *
   * Omit it and the source counts only towards the combined total, which is
   * what a single-board page wants.
   */
  readonly series?: string;
}

/** Which years, months and days hold activity, and the extremes. */
export interface DataCalendar {
  readonly years: ReadonlySet<string>;
  readonly months: ReadonlySet<string>;
  /** Only for the month that was asked about; the drill needs no more. */
  readonly days: ReadonlySet<string>;
  readonly earliest: string | null;
  readonly latest: string | null;
  readonly total: number;
}

export const EMPTY_CALENDAR: DataCalendar = {
  years: new Set(),
  months: new Set(),
  days: new Set(),
  earliest: null,
  latest: null,
  total: 0,
};

/**
 * ONE STATEMENT for the whole control, and this is the constraint that shaped
 * it.
 *
 * Marking the empty periods is the most useful thing on the control and it
 * must not cost a round trip per level. So the years, the months, the days of
 * the one month being drilled into, and the two extremes all come back from a
 * single UNION ALL over a shared source. Days are restricted to the month in
 * question because a drill only ever shows one month's days, and returning
 * every day of every year would be thousands of rows nobody renders.
 *
 * The table and column names are literals from the calling page, never request
 * input. Every value that comes from a request is bound.
 */
export function calendarSql(sources: readonly CalendarSource[]): string {
  const union = sources
    .map(
      (s) =>
        `SELECT ${s.column} AS dt, ${s.series === undefined ? "''" : `'${s.series}'`} AS series` +
        ` FROM ${s.table} WHERE ${s.column} IS NOT NULL` +
        (s.where === undefined ? '' : ` AND ${s.where}`),
    )
    .join('\n      UNION ALL\n      ');
  // STILL ONE STATEMENT. The series is another GROUP BY column, not another
  // round trip: marking the empty periods is the most useful thing on the
  // control and it must not cost a query per board. The `''` rows are the
  // combined population the page's own period is resolved from, and they are
  // produced by the same scan rather than by a second pass.
  return `
    WITH src AS (
      ${union}
    ),
    all_src AS (SELECT dt, '' AS series FROM src UNION ALL SELECT dt, series FROM src WHERE series <> '')
    SELECT 'Y' AS lvl, substr(dt, 1, 4) AS k, series, COUNT(*) AS n FROM all_src GROUP BY 2, 3
    UNION ALL
    SELECT 'M', substr(dt, 1, 7), series, COUNT(*) FROM all_src GROUP BY 2, 3
    UNION ALL
    SELECT 'D', substr(dt, 1, 10), series, COUNT(*) FROM all_src
      WHERE substr(dt, 1, 7) = ? GROUP BY 2, 3
    UNION ALL
    SELECT 'X', MIN(dt), series, COUNT(*) FROM all_src GROUP BY 3
    UNION ALL
    SELECT 'Z', MAX(dt), series, COUNT(*) FROM all_src GROUP BY 3`;
}

/** Read the one statement's rows into the calendar the control renders from. */
export function readCalendar(rows: readonly Record<string, unknown>[]): DataCalendar {
  return readCalendars(rows).combined;
}

/**
 * The combined calendar, and one per series.
 *
 * The page resolves its period from `combined`; each panel checks its own
 * board against `series.get(name)`. Both come from the same statement's rows,
 * so a panel can never be checking a different read from the one the period was
 * chosen with.
 */
export interface CalendarSet {
  readonly combined: DataCalendar;
  readonly series: ReadonlyMap<string, DataCalendar>;
}

export function readCalendars(rows: readonly Record<string, unknown>[]): CalendarSet {
  const building = new Map<
    string,
    {
      years: Set<string>;
      months: Set<string>;
      days: Set<string>;
      earliest: string | null;
      latest: string | null;
      total: number;
    }
  >();
  const of = (name: string) => {
    let found = building.get(name);
    if (found === undefined) {
      found = {
        years: new Set(),
        months: new Set(),
        days: new Set(),
        earliest: null,
        latest: null,
        total: 0,
      };
      building.set(name, found);
    }
    return found;
  };

  for (const row of rows) {
    const lvl = String(row.lvl ?? '');
    const k = row.k === null || row.k === undefined ? null : String(row.k);
    if (k === null) continue;
    const bucket = of(String(row.series ?? ''));
    if (lvl === 'Y') bucket.years.add(k);
    else if (lvl === 'M') bucket.months.add(k);
    else if (lvl === 'D') bucket.days.add(k);
    else if (lvl === 'X') {
      bucket.earliest = k.slice(0, 10);
      bucket.total = Number(row.n ?? 0);
    } else if (lvl === 'Z') bucket.latest = k.slice(0, 10);
  }

  const freeze = (name: string): DataCalendar => {
    const b = building.get(name);
    return b === undefined ? EMPTY_CALENDAR : { ...b };
  };
  const series = new Map<string, DataCalendar>();
  for (const name of building.keys()) if (name !== '') series.set(name, freeze(name));
  return { combined: freeze(''), series };
}

/** Whether a period holds anything, answered from the calendar alone. */
export function periodHasData(period: ResolvedPeriod, calendar: DataCalendar): boolean {
  if (calendar.total === 0) return false;
  if (period.from === null || period.to === null) return true;
  if (calendar.earliest === null || calendar.latest === null) return false;
  // An overlap test, not a containment test: a quarter holds data when any of
  // its months does, and a custom range that straddles the extract's edge is
  // not empty.
  if (period.level === 'YEAR') return calendar.years.has(period.from.slice(0, 4));
  if (period.level === 'MONTH') return calendar.months.has(period.from.slice(0, 7));
  if (period.level === 'DAY') return calendar.days.has(period.from);
  for (const month of calendar.months) {
    if (month >= period.from.slice(0, 7) && month <= period.to.slice(0, 7)) return true;
  }
  return false;
}

/** What the page settled on, and what it moved away from to get there. */
export interface PeriodChoice {
  readonly period: ResolvedPeriod;
  /** The period that was asked for and found empty, where that happened. */
  readonly fellBackFrom: ResolvedPeriod | null;
  /** The one line the page prints when it moved. */
  readonly notice: string | null;
}

/**
 * The rule that stops a working system looking broken.
 *
 * A period the reader NAMED is honoured even when it is empty: they asked for
 * August, they get August, and moving them somewhere else would be the page
 * arguing with them. Only the DEFAULT falls back, because nobody chose it, and
 * an unchosen empty view is the page's own failure rather than the reader's.
 */
export function choosePeriod(
  asked: ResolvedPeriod,
  calendar: DataCalendar,
  today: Date,
  explicit: boolean,
): PeriodChoice {
  if (explicit || calendar.total === 0 || periodHasData(asked, calendar)) {
    return { period: asked, fellBackFrom: null, notice: null };
  }
  if (calendar.latest === null) return { period: asked, fellBackFrom: null, notice: null };
  // The most recent period OF THE SAME SHAPE that holds data, so a default of
  // "this month" falls back to a month and not to a fortnight.
  const target =
    asked.level === 'YEAR'
      ? calendar.latest.slice(0, 4)
      : asked.level === 'DAY'
        ? calendar.latest
        : calendar.latest.slice(0, 7);
  const moved = periodFromToken(target, today);
  if (moved === null) return { period: asked, fellBackFrom: null, notice: null };
  return {
    period: moved,
    fellBackFrom: asked,
    notice: `No activity in ${asked.label}. Showing ${moved.label}, the most recent ${
      asked.level === 'YEAR' ? 'year' : asked.level === 'DAY' ? 'day' : 'month'
    } with data.`,
  };
}

/** Whether the request named a period, as opposed to taking the default. */
export function periodWasChosen(params: URLSearchParams): boolean {
  return (params.get('period') ?? '').trim() !== '';
}

/* -------------------------------------------------------------------------
 * THE DRILL
 * ------------------------------------------------------------------------- */

/** The years the drill offers, newest first, each marked for data. */
export function drillYears(
  calendar: DataCalendar,
  today: Date,
): { key: string; hasData: boolean }[] {
  const years = new Set<string>(calendar.years);
  years.add(String(today.getUTCFullYear()));
  return [...years]
    .sort((a, b) => b.localeCompare(a))
    .map((key) => ({ key, hasData: calendar.years.has(key) }));
}

/** Every month of a year, in order, each marked for data. */
export function drillMonths(
  year: string,
  calendar: DataCalendar,
): { key: string; label: string; hasData: boolean }[] {
  return MONTH_NAMES.map((name, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    return { key, label: name, hasData: calendar.months.has(key) };
  });
}

/** Every day of a month, in order, each marked for data. */
export function drillDays(
  month: string,
  calendar: DataCalendar,
): { key: string; label: string; hasData: boolean }[] {
  const { y, m } = partsOf(`${month}-01`);
  const last = endOfMonth(y, m).getUTCDate();
  const out: { key: string; label: string; hasData: boolean }[] = [];
  for (let d = 1; d <= last; d += 1) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    out.push({ key, label: String(d), hasData: calendar.days.has(key) });
  }
  return out;
}

/** The year and month the drill is currently open at, from the period. */
export function drillPosition(
  period: ResolvedPeriod,
  today: Date,
): { year: string; month: string } {
  const from = period.from ?? ymd(today);
  return { year: from.slice(0, 4), month: from.slice(0, 7) };
}

/* -------------------------------------------------------------------------
 * THE BRIDGE INTO THE EXISTING FILTER
 * ------------------------------------------------------------------------- */

/**
 * The period, applied to the analytics filter every existing query already
 * reads.
 *
 * THIS IS WHY THERE IS ONE IMPLEMENTATION AND NOT FIVE. Six analytical phases
 * built their queries against `AnalyticsFilter.from`, `.to` and `.grain`.
 * Rewriting each of them to take a period would have meant five migrations and
 * five chances to diverge; overwriting those three fields from the resolved
 * period means every query on every one of those pages obeys the control
 * without being touched, and a page cannot opt half of itself out.
 *
 * It is applied by the PAGE rather than inside `parseFilter`, deliberately.
 * `parseFilter` is called by two dozen API routes whose default is all time,
 * and silently narrowing every one of them to the current month would empty
 * screens nobody changed. A page that wants the control calls this; nothing
 * else changes behaviour.
 */
export function withPeriod<T extends { from: string | null; to: string | null; grain: string }>(
  filter: T,
  period: ResolvedPeriod,
): T {
  return { ...filter, from: period.from, to: period.to, grain: period.grain };
}

/** Everything a page needs to render the control, from one calendar read. */
export interface PeriodPage {
  readonly asked: ResolvedPeriod;
  readonly period: ResolvedPeriod;
  readonly calendar: DataCalendar;
  readonly notice: string | null;
  readonly fellBackFrom: ResolvedPeriod | null;
  /** Whether `?pick=1` asked for the drill to be open. */
  readonly open: boolean;
  /** The month whose days the drill should offer, for the calendar's bind. */
  readonly drillMonth: string;
}

/** The period a page landed on, given the one calendar statement's rows. */
export function resolvePeriodPage(
  params: URLSearchParams,
  today: Date,
  calendarRows: readonly Record<string, unknown>[],
): PeriodPage {
  const asked = parsePeriod(params, today);
  const calendar = readCalendar(calendarRows);
  const choice = choosePeriod(asked, calendar, today, periodWasChosen(params));
  return {
    asked,
    period: choice.period,
    calendar,
    notice: choice.notice,
    fellBackFrom: choice.fellBackFrom,
    open: params.get('pick') === '1',
    drillMonth: (asked.from ?? '').slice(0, 7),
  };
}

/** The month to bind into `calendarSql`, before the rows come back. */
export function drillMonthOf(params: URLSearchParams, today: Date): string {
  return (parsePeriod(params, today).from ?? '').slice(0, 7);
}
