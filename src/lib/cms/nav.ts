/**
 * The CMS navigation rail.
 *
 * The rail has to become permission-driven, so the navigation is data rather than markup: one typed array, one component (CmsSidebar.astro) that renders it, and one place to change when a module arrives. Markup that hard-codes destinations cannot be filtered later without being rewritten, which is the mistake this avoids.
 *
 * IT IS NOW DERIVED RATHER THAN WRITTEN. The rail is the subset of
 * ./destinations.ts that carries an icon, because that catalogue also feeds
 * the Administration page and page search, and three hand-maintained lists of
 * the same destinations diverge on the first change nobody remembers to make
 * in all three. A rail entry's label, path and permission are stated once.
 *
 * Paths are root-relative on cms.murikah.com. The worker has already rewritten
 * the request to the internal /cms route by the time a page renders, so a link
 * is written `/app/customers`, never `/cms/app/customers`. See
 * src/lib/hosts/cms.ts.
 */
import type { CmsIconName } from '@/components/cms/icons';
import { CMS_DESTINATIONS, destinationAllowed } from './destinations.ts';

export interface CmsNavItem {
  /** The visible label. Recognition over recall: never a code, always a word. */
  readonly label: string;
  /** Root-relative path on the CMS host. */
  readonly href: string;
  /** Icon key, resolved by CmsIcon.astro. Decorative, always beside a label. */
  readonly icon: CmsIconName;
  /**
   * The permission this destination requires, in the database's own
   * MODULE.RESOURCE.ACTION form. `null` means any authenticated user, which is
   * true of exactly one entry: the landing page they are redirected to.
   *
   * A list means any one of them is enough. Administration is the reason: it
   * covers more than one subject, and a Country Manager holding only
   * ADMIN.ORGANISATION.VIEW would otherwise be given a workspace with no route
   * to it.
   */
  readonly permission: string | readonly string[] | null;
}

/**
 * The rail, in rail order: the catalogue entries that carry an icon.
 *
 * An icon is the marker because it is the thing only a rail entry needs. A
 * separate `rail: true` flag would be a second fact to keep true; this one
 * cannot be set without also giving the entry the picture it renders.
 */
export const CMS_NAV: readonly CmsNavItem[] = CMS_DESTINATIONS.filter(
  (destination): destination is typeof destination & { icon: CmsIconName } =>
    destination.icon !== undefined,
).map((destination) => ({
  label: destination.label,
  href: destination.href,
  icon: destination.icon,
  permission: destination.permission,
}));

/** Whether a principal's codes satisfy one entry's requirement. */
export function navItemAllowed(item: CmsNavItem, permissions: readonly string[]): boolean {
  return destinationAllowed(item, permissions);
}

/**
 * The entries this principal may see.
 *
 * Presentation, not access control: hiding a link stops nobody from typing its
 * URL. The endpoints and the pages behind them authorise for themselves, in
 * @/lib/cms/admin/guard, and would refuse the same caller whether or not this
 * filter had hidden anything.
 */
export function visibleNav(permissions: readonly string[]): CmsNavItem[] {
  return CMS_NAV.filter((item) => navItemAllowed(item, permissions));
}

/**
 * The entry whose href best matches a visitor-facing path, or null. Longest
 * match wins, so /customers/123 marks Customers rather than Home. Exported so
 * the shell can mark the active item and title the page from one source.
 */
export function activeNavItem(path: string): CmsNavItem | null {
  let best: CmsNavItem | null = null;
  for (const item of CMS_NAV) {
    if (item.href === '/app') {
      if (path === '/app' && best === null) best = item;
      continue;
    }
    if (path === item.href || path.startsWith(item.href + '/')) {
      if (best === null || item.href.length > best.href.length) best = item;
    }
  }
  return best ?? (path === '/app' ? (CMS_NAV[0] ?? null) : null);
}
