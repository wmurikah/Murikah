/**
 * The CMS navigation rail.
 *
 * The rail is derived from the destination catalogue and filtered by resolved
 * permission codes. The historic SLA dashboard route remains `/app/performance`
 * for bookmarks, but its user-facing job is now Exceptions.
 */
import type { CmsIconName } from '@/components/cms/icons';
import { CMS_DESTINATIONS, destinationAllowed } from './destinations.ts';

export interface CmsNavItem {
  readonly label: string;
  readonly href: string;
  readonly icon: CmsIconName;
  readonly permission: string | readonly string[] | null;
}

const publicLabel = (label: string): string => (label === 'SLA Monitor' ? 'Exceptions' : label);

export const CMS_NAV: readonly CmsNavItem[] = CMS_DESTINATIONS.filter(
  (destination): destination is typeof destination & { icon: CmsIconName } =>
    destination.icon !== undefined,
).map((destination) => ({
  label: publicLabel(destination.label),
  href: destination.href,
  icon: destination.icon,
  permission: destination.permission,
}));

export function navItemAllowed(item: CmsNavItem, permissions: readonly string[]): boolean {
  return destinationAllowed(item, permissions);
}

export function visibleNav(permissions: readonly string[]): CmsNavItem[] {
  return CMS_NAV.filter((item) => navItemAllowed(item, permissions));
}

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
