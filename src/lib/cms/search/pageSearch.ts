/**
 * "Go to" — searching the application's own destinations, not its records.
 *
 * THE PROBLEM THIS SOLVES IS RECALL. The rail holds eight entries and the
 * product has about forty screens, so finding Lead sources meant knowing it
 * lives under CRM, and finding Access review meant knowing it is
 * administration rather than a report. Somebody who knows what they want and
 * not where it is has, until now, had no way to say so.
 *
 * NO DATABASE. The destinations are static and are already in
 * ../destinations.ts; the permissions are already resolved on the request. So
 * this is a filter and a sort over an in-memory array, and a search that finds
 * pages costs the same as a search that does not. Nothing here adds a query to
 * a page render, which is the failure mode a navigation feature invites.
 *
 * PERMISSION FILTERING IS NAVIGATION ASSISTANCE, NOT ACCESS CONTROL. A person
 * without ADMIN.USERS.MANAGE is not offered Users, because offering a door
 * somebody cannot open is a worse experience than not mentioning it. The page
 * behind it refuses them independently, exactly as it did before this existed,
 * and would refuse them if this filter were deleted.
 *
 * THE RANKING IS FOUR BANDS, matching the record search's own bands so the two
 * halves of one result list are ordered on comparable terms. A person typing
 * "users" gets the Users page above a customer whose name contains the word,
 * because an exact label match is band 0 and a substring is band 3.
 */
import { allowedDestinations, type CmsDestination } from '../destinations.ts';

export interface PageHit {
  label: string;
  href: string;
  /** The area, so "Leads" reads as CRM's Leads rather than as a bare word. */
  context: string;
  /** Lower sorts first, and shares the record search's band numbering. */
  rank: number;
}

/**
 * The bands, and what each one means to somebody typing.
 *
 * EXACT   I typed the name of the page.
 * PREFIX  I typed the beginning of it.
 * KEYWORD I typed a word for it that is not its name — "log" for Audit trail.
 * CONTAINS it merely contains what I typed.
 *
 * A keyword sits BELOW a prefix on purpose: somebody typing "imp" almost
 * certainly means Import history, and should not be beaten by the Upload
 * Centre's "import" alias.
 */
const RANK = { EXACT: 0, PREFIX: 1, KEYWORD: 2, CONTAINS: 3 } as const;

/** Two characters is the floor, as it is for records: one matches everything. */
export const MIN_PAGE_QUERY_LENGTH = 2;
/** Enough to be useful, few enough that pages never crowd out the records. */
export const PAGE_LIMIT = 6;

function bandFor(destination: CmsDestination, query: string): number | null {
  const label = destination.label.toLowerCase();
  if (label === query) return RANK.EXACT;
  if (label.startsWith(query)) return RANK.PREFIX;
  const keywords = destination.keywords ?? [];
  if (keywords.some((word) => word === query || word.startsWith(query))) return RANK.KEYWORD;
  if (label.includes(query)) return RANK.CONTAINS;
  if (keywords.some((word) => word.includes(query))) return RANK.CONTAINS;
  return null;
}

/**
 * The destinations this person may open that match what they typed.
 *
 * Ties break on the label, so the same query always produces the same order —
 * a result list that shuffles between keystrokes is one nobody can aim at.
 */
export function searchPages(permissions: readonly string[], rawQuery: string): PageHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < MIN_PAGE_QUERY_LENGTH) return [];

  const hits: PageHit[] = [];
  for (const destination of allowedDestinations(permissions)) {
    const rank = bandFor(destination, query);
    if (rank === null) continue;
    hits.push({
      label: destination.label,
      href: destination.href,
      // The rail entries are the areas, so saying "Main" of them would be
      // saying nothing; they are named by what they are instead.
      context: destination.area === 'Main' ? 'Main navigation' : destination.area,
      rank,
    });
  }
  hits.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return hits.slice(0, PAGE_LIMIT);
}
