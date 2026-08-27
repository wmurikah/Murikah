/**
 * The one analytics filter, defined here and parsed here.
 *
 * Six analytical phases share this object. Defining it once is not tidiness:
 * a second parser drifts from the first, and the day a country filter means
 * something slightly different on two pages is the day the two pages
 * disagree about the same number and nobody can say which is right.
 *
 * IT LIVES IN THE URL. Every analytical page reads its filter from the query
 * string and writes it back, so a view can be sent to somebody else and a
 * drill-down arrives carrying the context it came from. A filter held only
 * in memory cannot be shared, and a drill-down that loses it shows a
 * different population from the number that was clicked.
 *
 * A FILTER IS NOT ACCESS CONTROL. Nothing here decides what a caller may
 * see. The Build Prompt 07 scope resolver does that, on every query, and a
 * filter only ever narrows what the scope already allows.
 */

export const PERIOD_GRAINS = ['DAY', 'WEEK', 'MONTH'] as const;
export type PeriodGrain = (typeof PERIOD_GRAINS)[number];

export const TRIPLE_STATES = ['ANY', 'YES', 'NO'] as const;
export type TripleState = (typeof TRIPLE_STATES)[number];

export interface AnalyticsFilter {
  /** Inclusive date floor, "YYYY-MM-DD", or null for no floor. */
  from: string | null;
  /** Inclusive date ceiling, "YYYY-MM-DD", or null for no ceiling. */
  to: string | null;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  accountId: string | null;
  productGroupId: string | null;
  productCategoryId: string | null;
  productId: string | null;
  supplier: string | null;
  status: string | null;
  stageCode: string | null;
  slaStatus: string | null;
  creditRequired: TripleState;
  ownerId: string | null;
  teamId: string | null;
  pipelineId: string | null;
  pipelineStageId: string | null;
  leadSourceId: string | null;
  caseCategoryId: string | null;
  currency: string | null;
  /** Trend bucket size. Daily points across a year are noise, so this adapts. */
  grain: PeriodGrain;
  /**
   * The minimum number of transactions before a person or entity is given a
   * comparative rank. Stated, never hidden, and adjustable by the reader.
   */
  minVolume: number;
  /** Repeat-issue window in days, used by the service analytics. */
  repeatDays: number;
}

export const DEFAULT_MIN_VOLUME = 10;
export const DEFAULT_REPEAT_DAYS = 90;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readDate(params: URLSearchParams, key: string): string | null {
  const raw = (params.get(key) ?? '').trim();
  return DATE.test(raw) ? raw : null;
}

function readText(params: URLSearchParams, key: string): string | null {
  const raw = (params.get(key) ?? '').trim();
  // Bounded, because every one of these reaches SQL as a bound parameter and
  // an unbounded string is a needless payload rather than a needless risk.
  return raw === '' ? null : raw.slice(0, 120);
}

function readNumber(params: URLSearchParams, key: string, fallback: number, max: number): number {
  // An absent parameter is absent, not zero. Number(null) is 0 and Number('')
  // is 0, so testing the parsed value alone would silently replace every
  // default with zero: a minimum volume of zero ranks a person with one
  // transaction against a person with three hundred, which is the exact
  // outcome the minimum exists to prevent.
  const value = params.get(key);
  if (value === null || value.trim() === '') return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

/**
 * The trend grain, chosen for the period when the reader has not chosen one.
 * A quarter of daily points is 90 marks nobody can read; a fortnight of
 * monthly points is one bar.
 */
export function defaultGrain(from: string | null, to: string | null): PeriodGrain {
  if (from === null || to === null) return 'MONTH';
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
  );
  if (!Number.isFinite(days)) return 'MONTH';
  if (days <= 31) return 'DAY';
  if (days <= 182) return 'WEEK';
  return 'MONTH';
}

export function parseFilter(params: URLSearchParams): AnalyticsFilter {
  const from = readDate(params, 'from');
  const to = readDate(params, 'to');
  const grainRaw = (params.get('grain') ?? '').toUpperCase();
  const creditRaw = (params.get('creditRequired') ?? '').toUpperCase();
  return {
    // A reversed range is a typing mistake, not a query: order the two ends
    // rather than returning nothing and letting the reader wonder why.
    from: from !== null && to !== null && from > to ? to : from,
    to: from !== null && to !== null && from > to ? from : to,
    countryId: readText(params, 'countryId'),
    affiliateId: readText(params, 'affiliateId'),
    businessUnitId: readText(params, 'businessUnitId'),
    accountId: readText(params, 'accountId'),
    productGroupId: readText(params, 'productGroupId'),
    productCategoryId: readText(params, 'productCategoryId'),
    productId: readText(params, 'productId'),
    supplier: readText(params, 'supplier'),
    status: readText(params, 'status'),
    stageCode: readText(params, 'stageCode'),
    slaStatus: readText(params, 'slaStatus'),
    creditRequired: (TRIPLE_STATES as readonly string[]).includes(creditRaw)
      ? (creditRaw as TripleState)
      : 'ANY',
    ownerId: readText(params, 'ownerId'),
    teamId: readText(params, 'teamId'),
    pipelineId: readText(params, 'pipelineId'),
    pipelineStageId: readText(params, 'pipelineStageId'),
    leadSourceId: readText(params, 'leadSourceId'),
    caseCategoryId: readText(params, 'caseCategoryId'),
    currency: readText(params, 'currency'),
    grain: (PERIOD_GRAINS as readonly string[]).includes(grainRaw)
      ? (grainRaw as PeriodGrain)
      : defaultGrain(from, to),
    minVolume: readNumber(params, 'minVolume', DEFAULT_MIN_VOLUME, 10000),
    repeatDays: readNumber(params, 'repeatDays', DEFAULT_REPEAT_DAYS, 3650),
  };
}

/**
 * The filter as a query string, so a drill-down carries its context and a
 * view can be shared. Absent values are omitted rather than written empty,
 * which keeps a shared link readable.
 */
export function filterToQuery(
  filter: AnalyticsFilter,
  extra: Record<string, string | null> = {},
): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | null) => {
    if (value !== null && value !== '') params.set(key, value);
  };
  put('from', filter.from);
  put('to', filter.to);
  put('countryId', filter.countryId);
  put('affiliateId', filter.affiliateId);
  put('businessUnitId', filter.businessUnitId);
  put('accountId', filter.accountId);
  put('productGroupId', filter.productGroupId);
  put('productCategoryId', filter.productCategoryId);
  put('productId', filter.productId);
  put('supplier', filter.supplier);
  put('status', filter.status);
  put('stageCode', filter.stageCode);
  put('slaStatus', filter.slaStatus);
  if (filter.creditRequired !== 'ANY') put('creditRequired', filter.creditRequired);
  put('ownerId', filter.ownerId);
  put('teamId', filter.teamId);
  put('pipelineId', filter.pipelineId);
  put('pipelineStageId', filter.pipelineStageId);
  put('leadSourceId', filter.leadSourceId);
  put('caseCategoryId', filter.caseCategoryId);
  put('currency', filter.currency);
  put('grain', filter.grain);
  if (filter.minVolume !== DEFAULT_MIN_VOLUME) put('minVolume', String(filter.minVolume));
  if (filter.repeatDays !== DEFAULT_REPEAT_DAYS) put('repeatDays', String(filter.repeatDays));
  for (const [key, value] of Object.entries(extra)) put(key, value);
  const rendered = params.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

/** A drill-down destination that keeps the filter and adds its own narrowing. */
export function drillTo(
  path: string,
  filter: AnalyticsFilter,
  extra: Record<string, string | null> = {},
): string {
  return `${path}${filterToQuery(filter, extra)}`;
}

export interface SqlFragment {
  sql: string;
  args: (string | number)[];
}

/**
 * The date window as SQL, against whichever column carries the metric's date
 * basis. The basis is always named by the caller, never assumed: an order
 * created in June and approved in July belongs to different periods
 * depending on the question, and the KPI definition says which.
 */
export function dateWindow(column: string, filter: AnalyticsFilter): SqlFragment {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (filter.from !== null) {
    parts.push(`${column} >= ?`);
    args.push(`${filter.from} 00:00:00`);
  }
  if (filter.to !== null) {
    parts.push(`${column} <= ?`);
    args.push(`${filter.to} 23:59:59`);
  }
  return { sql: parts.length === 0 ? '1 = 1' : parts.join(' AND '), args };
}

/**
 * The trend bucket expression for a grain. SQLite's strftime gives the month
 * and the ISO-ish week without a date library, which this repository does not
 * have and may not add.
 */
export function bucketExpression(column: string, grain: PeriodGrain): string {
  if (grain === 'DAY') return `strftime('%Y-%m-%d', ${column})`;
  if (grain === 'WEEK') return `strftime('%Y-W%W', ${column})`;
  return `strftime('%Y-%m', ${column})`;
}

/** Combine fragments into one WHERE body, dropping the empty ones. */
export function andAll(fragments: SqlFragment[]): SqlFragment {
  const live = fragments.filter((fragment) => fragment.sql !== '' && fragment.sql !== '1 = 1');
  if (live.length === 0) return { sql: '1 = 1', args: [] };
  return {
    sql: live.map((fragment) => `(${fragment.sql})`).join(' AND '),
    args: live.flatMap((fragment) => fragment.args),
  };
}

/** An equality narrowing, or nothing at all when the filter is unset. */
export function equals(column: string, value: string | null): SqlFragment {
  return value === null ? { sql: '1 = 1', args: [] } : { sql: `${column} = ?`, args: [value] };
}
