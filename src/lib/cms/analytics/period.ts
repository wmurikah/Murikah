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

/* -------------------------------------------------------------------------
 * WHICH PERIODS HOLD DATA
 * ------------------------------------------------------------------------- */

/** One date column that counts as activity for this page. */
export interface CalendarSource {
  readonly table: string;
  readonly column: string;
  /** An optional extra restriction, already safe: no caller input reaches it. */
  readonly where?: string;
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
        `SELECT ${s.column} AS dt FROM ${s.table} WHERE ${s.column} IS NOT NULL` +
        (s.where === undefined ? '' : ` AND ${s.where}`),
    )
    .join('\n      UNION ALL\n      ');
  return `
    WITH src AS (
      ${union}
    )
    SELECT 'Y' AS lvl, substr(dt, 1, 4) AS k, COUNT(*) AS n FROM src GROUP BY 2
    UNION ALL
    SELECT 'M', substr(dt, 1, 7), COUNT(*) FROM src GROUP BY 2
    UNION ALL
    SELECT 'D', substr(dt, 1, 10), COUNT(*) FROM src WHERE substr(dt, 1, 7) = ? GROUP BY 2
    UNION ALL
    SELECT 'X', MIN(dt), COUNT(*) FROM src
    UNION ALL
    SELECT 'Z', MAX(dt), COUNT(*) FROM src`;
}

/** Read the one statement's rows into the calendar the control renders from. */
export function readCalendar(rows: readonly Record<string, unknown>[]): DataCalendar {
  const years = new Set<string>();
  const months = new Set<string>();
  const days = new Set<string>();
  let earliest: string | null = null;
  let latest: string | null = null;
  let total = 0;
  for (const row of rows) {
    const lvl = String(row.lvl ?? '');
    const k = row.k === null || row.k === undefined ? null : String(row.k);
    if (k === null) continue;
    if (lvl === 'Y') years.add(k);
    else if (lvl === 'M') months.add(k);
    else if (lvl === 'D') days.add(k);
    else if (lvl === 'X') {
      earliest = k.slice(0, 10);
      total = Number(row.n ?? 0);
    } else if (lvl === 'Z') latest = k.slice(0, 10);
  }
  return { years, months, days, earliest, latest, total };
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
