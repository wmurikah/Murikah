/**
 * The CMS navigation model.
 *
 * The sidebar has to become permission-driven in a later phase, so the
 * navigation is data rather than markup: one typed array here, one component
 * (CmsSidebar.astro) that renders it, and one place to change when a module
 * arrives. Markup that hard-codes destinations cannot be filtered later without
 * being rewritten, which is the mistake this avoids.
 *
 * Every entry already carries the permission key it will require. Nothing reads
 * that key yet, and nothing filters on it: this phase renders every entry. When
 * the session lands, the filter is one `.filter()` in the sidebar and a role
 * lookup, with no change to the entries themselves.
 *
 * Paths are root-relative on cms.murikah.com. The worker has already rewritten
 * the request to the internal /cms route by the time a page renders, so a link
 * is written `/customers`, never `/cms/customers`. See src/lib/hosts/cms.ts.
 */
import type { CmsIconName } from '@/components/cms/icons';

export interface CmsNavItem {
  /** The visible label. Recognition over recall: never a code, always a word. */
  readonly label: string;
  /** Root-relative path on the CMS host. */
  readonly href: string;
  /** Icon key, resolved by CmsIcon.astro. Decorative, always beside a label. */
  readonly icon: CmsIconName;
  /**
   * The permission this destination will require once sessions exist. Declared
   * now so the model is complete; deliberately unread in this phase.
   */
  readonly permission: string;
  /** One line of context for the section landing page and the page header. */
  readonly summary: string;
}

export const CMS_NAV: readonly CmsNavItem[] = [
  {
    label: 'Home',
    href: '/',
    icon: 'home',
    permission: 'cms.home.view',
    summary: 'Today across service, orders and accounts.',
  },
  {
    label: 'Customers',
    href: '/customers',
    icon: 'customers',
    permission: 'cms.customers.view',
    summary: 'Accounts, contacts, delivery locations and documents.',
  },
  {
    label: 'CRM',
    href: '/crm',
    icon: 'crm',
    permission: 'cms.crm.view',
    summary: 'Leads, opportunities, retention and churn risk.',
  },
  {
    label: 'Service',
    href: '/service',
    icon: 'service',
    permission: 'cms.service.view',
    summary: 'Tickets, escalations and the SLA clock.',
  },
  {
    label: 'Orders',
    href: '/orders',
    icon: 'orders',
    permission: 'cms.orders.view',
    summary: 'Sales orders, purchase orders, invoices and deliveries.',
  },
  {
    label: 'Performance',
    href: '/performance',
    icon: 'performance',
    permission: 'cms.performance.view',
    summary: 'SLA attainment, resolution times and team load.',
  },
  {
    label: 'Data',
    href: '/data',
    icon: 'data',
    permission: 'cms.data.view',
    summary: 'Reference data, imports and integration activity.',
  },
  {
    label: 'Administration',
    href: '/administration',
    icon: 'administration',
    permission: 'cms.admin.view',
    summary: 'Users, roles, teams and system configuration.',
  },
];

/**
 * The entry whose href best matches a visitor-facing path, or null. Longest
 * match wins, so /customers/123 marks Customers rather than Home. Exported so
 * the shell can mark the active item and title the page from one source.
 */
export function activeNavItem(path: string): CmsNavItem | null {
  let best: CmsNavItem | null = null;
  for (const item of CMS_NAV) {
    if (item.href === '/') {
      if (path === '/' && best === null) best = item;
      continue;
    }
    if (path === item.href || path.startsWith(item.href + '/')) {
      if (best === null || item.href.length > best.href.length) best = item;
    }
  }
  return best ?? (path === '/' ? (CMS_NAV[0] ?? null) : null);
}
