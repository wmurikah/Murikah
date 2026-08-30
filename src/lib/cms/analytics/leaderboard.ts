/**
 * The leaderboard's eight columns, defined once for both tables.
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

/** The plain-English headers, in the one order both tables use. */
export const LEADERBOARD_HEADERS = [
  'Person',
  'Function',
  'Volume',
  'Typical',
  'Slowest 10%',
  'Within SLA',
  'Pending',
  'Oldest pending',
] as const;

/** What each column measures, with its technical name stated exactly. */
export const LEADERBOARD_DEFINITIONS: Readonly<Record<string, string>> = {
  Person:
    'Who performed the function. Invoicing and loading authority record no actor in the source ' +
    'extract, so those rows read "Not recorded" rather than attributing the work to whoever last ' +
    'touched the order.',
  Function:
    'Which step was performed. Purchase order functions are the configured approval levels; sales ' +
    'order functions are finance approval, credit release, invoicing and loading authority.',
  Volume: 'How many of this function this person completed inside the period.',
  Typical:
    'The MEDIAN, also written P50. Half of this person’s completions of this function were faster ' +
    'than this figure and half were slower. It is not an average: an average is pulled upward by a ' +
    'single long hold and this is not.',
  'Slowest 10%':
    'The 90th PERCENTILE, written P90. Nine of ten completions were faster than this figure and one ' +
    'in ten was slower. It is the cost of the tail rather than the cost of a normal approval.',
  'Within SLA':
    'The share of completions that met the configured SLA target, counted only over completions ' +
    'where a target resolves. Targets are measured in business hours and these durations are ' +
    'elapsed, so the two agree within a working day and diverge across a weekend. Clicking opens ' +
    'the breaches, since those are the actionable half.',
  Pending: 'How many of this function are still waiting on this person right now.',
  'Oldest pending':
    'When the longest-waiting item on this person for this function began waiting. It opens that ' +
    'one record.',
};

/**
 * The columns as the table takes them.
 *
 * `numeric` right-aligns and gives tabular figures so digits line up down the
 * column; `secondary` hides a column of context below the small breakpoint
 * rather than letting eight columns squeeze a phone.
 */
export function leaderboardColumns(denominator: string, dateBasis: string): CmsColumn[] {
  const base: { key: string; label: string; numeric?: boolean; secondary?: boolean }[] = [
    { key: 'person', label: 'Person' },
    { key: 'function', label: 'Function' },
    { key: 'volume', label: 'Volume', numeric: true },
    { key: 'typical', label: 'Typical', numeric: true },
    { key: 'slowest10', label: 'Slowest 10%', numeric: true },
    { key: 'within', label: 'Within SLA', numeric: true, secondary: true },
    { key: 'pending', label: 'Pending', numeric: true },
    { key: 'oldest', label: 'Oldest pending', secondary: true },
  ];
  return base.map((column) => ({
    ...column,
    definition: LEADERBOARD_DEFINITIONS[column.label],
    denominator,
    dateBasis,
  }));
}

/** Which records a column's figure opens. Six columns, six destinations. */
export const FIGURE_DESTINATIONS: Readonly<Record<string, string>> = {
  Volume: 'completed',
  Typical: 'typical',
  'Slowest 10%': 'tail',
  'Within SLA': 'breaches',
  Pending: 'pending',
  'Oldest pending': 'record',
};
