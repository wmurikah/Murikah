/**
 * The CMS navigation model.
 *
 * The sidebar has to become permission-driven in a later phase, so the
 * navigation is data rather than markup: one typed array here, one component
 * (CmsSidebar.astro) that renders it, and one place to change when a module
 * arrives. Markup that hard-codes destinations cannot be filtered later without
 * being rewritten, which is the mistake this avoids.
 *
 * Every entry carries the permission it requires, and Build Prompt 04 turned
 * that from a promise into a filter: the sidebar renders `visibleNav(...)` and
 * nothing else. The entries themselves did not have to change when it did,
 * which was the point of writing the model as data in the first place.
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
   * The permission this destination requires, in the database's own
   * MODULE.RESOURCE.ACTION form. `null` means any authenticated user, which is
   * true of exactly one entry: the landing page they are redirected to.
   *
   * A list means any one of them is enough. Administration is the reason: it
   * covers more than one subject, and a Country Manager holding only
   * ADMIN.ORGANISATION.VIEW would otherwise be given a workspace with no route
   * to it. The alternative was to widen a single code until it meant
   * "administration in general", which is how a permission stops meaning
   * anything.
   *
   * These were placeholders of the form `cms.customers.view` when the model was
   * written, before the schema was available. They are now the real codes from
   * the `permissions` table, because a key that matches nothing would hide
   * every entry from everybody.
   */
  readonly permission: string | readonly string[] | null;
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
    label: 'Executive',
    href: '/app/executive',
    icon: 'performance',
    permission: [
      'ORDERS.SALES_ORDER.VIEW',
      'ORDERS.PURCHASE_ORDER.VIEW',
      'CRM.OPPORTUNITIES.VIEW',
      'SERVICE.CASES.VIEW',
    ],
    summary: 'Where to pay attention, across commercial, operational and service.',
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
    permission: [
      'ADMIN.USERS.MANAGE',
      'ADMIN.ORGANISATION.VIEW',
      'ADMIN.ORGANISATION.MANAGE',
      'ADMIN.ROLES.MANAGE',
      'ADMIN.WORKFLOWS.MANAGE',
      'ADMIN.WORKFLOW_ROLES.MANAGE',
      'ADMIN.PRODUCT_CATALOG.MANAGE',
    ],
    summary: 'Users, roles, organisation structure and system configuration.',
  },
];

/** Whether a principal's codes satisfy one entry's requirement. */
export function navItemAllowed(item: CmsNavItem, permissions: readonly string[]): boolean {
  if (item.permission === null) return true;
  if (typeof item.permission === 'string') return permissions.includes(item.permission);
  return item.permission.some((code) => permissions.includes(code));
}

/**
 * The entries this principal may see.
 *
 * Presentation, not access control: hiding a link stops nobody from typing the
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
