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
   * The permission code this destination requires, in the database's own
   * MODULE.RESOURCE.ACTION form. `null` means any authenticated user, which is
   * true of exactly one entry: the landing page they are redirected to.
   *
   * These were placeholders of the form `cms.customers.view` when the model was
   * written, before the schema was available. They are now the real codes from
   * the `permissions` table, because a key that matches nothing would hide
   * every entry from everybody.
   */
  readonly permission: string | null;
  /** One line of context for the section landing page and the page header. */
  readonly summary: string;
}

export const CMS_NAV: readonly CmsNavItem[] = [
  {
    label: 'Home',
    href: '/app',
    icon: 'home',
    permission: null,
    summary: 'Today across service, orders and accounts.',
  },
  {
    label: 'Customers',
    href: '/app/customers',
    icon: 'customers',
    permission: 'CUSTOMERS.ACCOUNTS.VIEW',
    summary: 'Accounts, contacts, delivery locations and documents.',
  },
  {
    label: 'CRM',
    href: '/app/crm',
    icon: 'crm',
    permission: 'CRM.LEADS.VIEW',
    summary: 'Leads, opportunities, retention and churn risk.',
  },
  {
    label: 'Service',
    href: '/app/service',
    icon: 'service',
    permission: 'SERVICE.CASES.VIEW',
    summary: 'Tickets, escalations and the SLA clock.',
  },
  {
    label: 'Orders',
    href: '/app/orders',
    icon: 'orders',
    permission: 'ORDERS.SALES_ORDER.VIEW',
    summary: 'Sales orders, purchase orders, invoices and deliveries.',
  },
  {
    label: 'Performance',
    href: '/app/performance',
    icon: 'performance',
    permission: 'SLA.DASHBOARD.VIEW',
    summary: 'SLA attainment, resolution times and team load.',
  },
  {
    label: 'Data',
    href: '/app/data',
    icon: 'data',
    permission: 'DATA.IMPORTS.VIEW',
    summary: 'Reference data, imports and integration activity.',
  },
  {
    label: 'Administration',
    href: '/app/administration',
    icon: 'administration',
    permission: 'ADMIN.USERS.MANAGE',
    summary: 'Users, roles, teams and system configuration.',
  },
];

/**
 * The entries this principal may see.
 *
 * Presentation, not access control: hiding a link stops nobody from typing the
 * URL. Server-side authorisation of the routes themselves is a later phase.
 */
export function visibleNav(permissions: readonly string[]): CmsNavItem[] {
  return CMS_NAV.filter(
    (item) => item.permission === null || permissions.includes(item.permission),
  );
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
