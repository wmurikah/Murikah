/**
 * "Go to" — searching the application's own destinations, not its records.
 */
import { allowedDestinations, type CmsDestination } from '../destinations.ts';

export interface PageHit {
  label: string;
  href: string;
  context: string;
  rank: number;
}

const RANK = { EXACT: 0, PREFIX: 1, KEYWORD: 2, CONTAINS: 3 } as const;
export const MIN_PAGE_QUERY_LENGTH = 2;
export const PAGE_LIMIT = 6;

const publicLabel = (destination: CmsDestination): string =>
  destination.label === 'SLA Monitor' ? 'Exceptions' : destination.label;

const publicContext = (destination: CmsDestination): string => {
  if (destination.area === 'Main') return 'Main navigation';
  if (destination.area === 'SLA Monitor') return 'Insights';
  return destination.area;
};

function bandFor(destination: CmsDestination, query: string): number | null {
  const label = publicLabel(destination).toLowerCase();
  if (label === query) return RANK.EXACT;
  if (label.startsWith(query)) return RANK.PREFIX;
  const keywords = destination.keywords ?? [];
  if (keywords.some((word) => word === query || word.startsWith(query))) return RANK.KEYWORD;
  if (label.includes(query)) return RANK.CONTAINS;
  if (keywords.some((word) => word.includes(query))) return RANK.CONTAINS;
  return null;
}

export function searchPages(permissions: readonly string[], rawQuery: string): PageHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < MIN_PAGE_QUERY_LENGTH) return [];

  const hits: PageHit[] = [];
  for (const destination of allowedDestinations(permissions)) {
    const rank = bandFor(destination, query);
    if (rank === null) continue;
    hits.push({
      label: publicLabel(destination),
      href: destination.href,
      context: publicContext(destination),
      rank,
    });
  }
  hits.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return hits.slice(0, PAGE_LIMIT);
}
