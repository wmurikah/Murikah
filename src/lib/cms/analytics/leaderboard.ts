/**
 * The leaderboard's four columns, defined once for both tables.
 *
 * BOTH LEADERBOARDS CARRY IDENTICAL COLUMNS IN IDENTICAL ORDER, and that is
 * what lets the eye move between them: a purchase order figure and a sales
 * order figure sit in the same place, so a reader compares position rather than
 * re-reading headers. Defining them here rather than in each table is what
 * makes that true by construction instead of by review.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND WHY
 * ---------------------------------------------------------------------------
 *
 * NO AVERAGE. On this data one 23,002-minute hold drags the mean upward far
 * enough that it describes nobody in the table. `Typical` and `Slowest 10%`
 * answer the two questions an average blurs into one — what a normal approval
 * costs, and what the tail costs — and neither can be recovered from the other.
 *
 * NO FASTEST COLUMN. Every person's fastest is zero to two minutes across every
 * function, so it distinguishes nobody and takes a column from something that
 * would.
 *
 * NO SLOWEST COLUMN. It inverts the ranking. On credit release one officer
 * holds the BEST slowest figure of the three while being clearly the worst on
 * every other measure, because a single order left over a holiday decides that
 * column. A person must never be ranked by one event outside their control.
 *
 * Both extremes still have a home: the row detail, where nothing sorts and
 * nothing ranks.
 *
 * NO FUNCTION COLUMN. It is a section heading above each block instead. Eight
 * columns did not fit at a laptop width and both tables scrolled sideways, and
 * a table you have to scroll to read is a table nobody reads. A heading is
 * scanned once; a repeated cell is read on every row. A person acting in two
 * functions still appears once under each, so the separation the whole design
 * rests on is unchanged — it moved from a column to a heading.
 *
 * NO WITHIN SLA COLUMN. No SLA targets are configured for these functions, so
 * it was empty on every row, and an empty column is worse than an absent one:
 * it takes width and teaches the reader that the table has nothing to say. It
 * comes back when targets exist.
 *
 * NO PENDING AND NO OLDEST PENDING. That information already sits directly
 * above each table — "1 in approval", "3 awaiting finance approval" — and it
 * belongs to the FUNCTION rather than to a person. Those lines stay, and are
 * links. The table is about people.
 *
 * ---------------------------------------------------------------------------
 * PLAIN WORDS IN THE HEADER, TECHNICAL NAMES IN THE DEFINITION
 * ---------------------------------------------------------------------------
 *
 * Nobody needs to know what a percentile is to understand that one approval in
 * ten took at least that long, so the header says `Slowest 10%`. Auditors and
 * the board do need the technical name to trace the figure, so the definition
 * states it exactly — the median, and the P90 with the wording that nine of ten
 * were faster and one in ten was slower.
 */
import type { CmsColumn } from '@/components/cms/CmsDataTable.astro';
import type { ApprovalActor, ApprovalProcess, RecordView } from '../repos/approvalSla.ts';
import { periodParams, type ResolvedPeriod } from './period.ts';

/** The plain-English headers, in the one order both tables use. */
export const LEADERBOARD_HEADERS = ['Person', 'Volume', 'Typical', 'Slowest 10%'] as const;

/** What each column measures, with its technical name stated exactly. */
export const LEADERBOARD_DEFINITIONS: Readonly<Record<string, string>> = {
  Person:
    'Who performed the function. Invoicing and loading authority record no actor in the source ' +
    'extract, so those rows read "Not recorded" rather than attributing the work to whoever last ' +
    'touched the order.',
  Volume: 'How many of this function this person completed inside the period.',
  Typical:
    'The MEDIAN, also written P50. Half of this person’s completions of this function were faster ' +
    'than this figure and half were slower. It is not an average: an average is pulled upward by a ' +
    'single long hold and this is not.',
  'Slowest 10%':
    'The 90th PERCENTILE, written P90. Nine of ten completions were faster than this figure and one ' +
    'in ten was slower. It is the cost of the tail rather than the cost of a normal approval.',
};

/**
 * The columns as the table takes them.
 *
 * `numeric` right-aligns and gives tabular figures so digits line up down the
 * column. Nothing is `secondary` any more: four columns fit at every width this
 * application supports, so there is no longer anything to hide on a phone.
 */
export function leaderboardColumns(denominator: string, dateBasis: string): CmsColumn[] {
  const base: { key: string; label: string; numeric?: boolean; secondary?: boolean }[] = [
    { key: 'person', label: 'Person' },
    { key: 'volume', label: 'Volume', numeric: true },
    { key: 'typical', label: 'Typical', numeric: true },
    { key: 'slowest10', label: 'Slowest 10%', numeric: true },
  ];
  return base.map((column) => ({
    ...column,
    definition: LEADERBOARD_DEFINITIONS[column.label],
    denominator,
    dateBasis,
  }));
}

/** Which records a figure opens. Every remaining figure is clickable. */
export const FIGURE_DESTINATIONS: Readonly<Record<string, string>> = {
  Volume: 'completed',
  Typical: 'typical',
  'Slowest 10%': 'tail',
};

/**
 * WHERE A FIGURE'S RECORDS LIVE, SERIALISED IN EXACTLY ONE PLACE.
 *
 * Every drillable figure in both panels comes through here: a bar, a point on a
 * trend, and each of the three columns. That is what makes "the destination
 * count equals the figure" a property of the code rather than an agreement
 * between two files. The failure it removes is specific and was live: the page
 * narrowed its aggregates by an affiliate while the leaderboard's own href
 * builder did not carry one, so every figure opened a wider population than the
 * number that was clicked, with nothing on either screen saying so.
 *
 * `person=none` is how the two sales order functions that record no actor are
 * addressed, and `all=1` is how a whole function across everybody is. An absent
 * `user` cannot mean both, which is why neither is expressed by absence.
 */
export function approvalRecordsHref(options: {
  readonly period: ResolvedPeriod;
  readonly affiliateId: string | null;
  readonly process: ApprovalProcess;
  readonly view: RecordView;
  readonly fn: string;
  readonly actor: ApprovalActor;
  /** The purchase order chart's product group, where the figure carries one. */
  readonly productGroup?: string | null;
}): string {
  const params = new URLSearchParams({
    ...periodParams(options.period),
    process: options.process,
    view: options.view,
    fn: options.fn,
  });
  if (options.affiliateId !== null) params.set('affiliateId', options.affiliateId);
  if (options.actor.kind === 'EVERYONE') params.set('all', '1');
  else if (options.actor.userId === null) params.set('person', 'none');
  else params.set('user', options.actor.userId);
  if (options.productGroup !== undefined && options.productGroup !== null) {
    params.set('group', options.productGroup);
  }
  return `/app/performance/approvals?${params.toString()}`;
}
