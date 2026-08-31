/**
 * EVERY PLACE A PERSON CAN GO, WRITTEN ONCE.
 *
 * The rail used to be the only catalogue of destinations, and it lists eight.
 * The application has fifty. So somebody looking for Lead sources had to know
 * it lives under CRM, and somebody looking for Access review had to open
 * Administration and read twelve equally weighted tiles. Recognition beats
 * recall, and neither of those is recognition.
 *
 * This is the catalogue behind both. The rail renders the entries that carry
 * an icon; the Administration page renders the ones in its area, in their
 * groups; global search offers all of them, filtered by the same permission
 * field. ONE LIST, so a destination cannot be searchable and unlisted, or
 * listed and unsearchable, and adding a page means adding a row here rather
 * than remembering three files.
 *
 * THE PERMISSION FIELD IS PRESENTATION, NOT ACCESS CONTROL — the same rule the
 * rail has always followed. Hiding a destination stops nobody from typing its
 * URL; every page behind these entries authorises for itself, and would refuse
 * the same caller whether or not this file ever mentioned it. What the field
 * buys is that a person is not offered a door they cannot open, which is a
 * usability property and not a security one.
 *
 * KEYWORDS EXIST BECAUSE PEOPLE DO NOT TYPE LABELS. Somebody looking for the
 * audit trail types "log". Somebody looking for the Upload Centre types
 * "import" or "excel". A search that only matched the visible label would make
 * the reader guess the product's vocabulary, which is exactly the recall this
 * is meant to remove.
 */
import type { CmsIconName } from '@/components/cms/icons';
import { ORGANISATION_PATH } from './admin/workspace.ts';
import { WORKFLOW_PATH } from './admin/workflowWorkspace.ts';

/**
 * Where a destination sits, for search grouping and for the pages that render
 * a section of the catalogue.
 */
export type DestinationArea =
  | 'Main'
  | 'Customers'
  | 'CRM'
  | 'Helpdesk'
  | 'Orders'
  | 'SLA Monitor'
  | 'Upload Centre'
  | 'Administration';

/**
 * The Administration chunking.
 *
 * Twelve destinations at equal visual weight is twelve decisions every time
 * somebody opens the page, and Hick's law says that costs time whether or not
 * the reader needs eleven of them. Four groups of two to five is a glance.
 *
 * ADVANCED IS LAST AND IS FOR TOOLING, not for the things an operator
 * administers. The design reference is a component gallery; it belongs in the
 * building where it is kept, not on the same shelf as Users.
 */
export type AdminGroup =
  | 'People & access'
  | 'Process & configuration'
  | 'Assurance & system'
  | 'Advanced';

export const ADMIN_GROUP_ORDER: readonly AdminGroup[] = [
  'People & access',
  'Process & configuration',
  'Assurance & system',
  'Advanced',
];

export interface CmsDestination {
  /** The visible label. Recognition over recall: never a code, always a word. */
  readonly label: string;
  /** Root-relative path on the CMS host. See src/lib/hosts/cms.ts. */
  readonly href: string;
  /**
   * The permission this destination requires, in the database's own
   * MODULE.RESOURCE.ACTION form. `null` means any authenticated user. A list
   * means any one of them is enough — Administration is the reason: it covers
   * more than one subject, and a Country Manager holding only
   * ADMIN.ORGANISATION.VIEW would otherwise be given a workspace with no route
   * to it.
   */
  readonly permission: string | readonly string[] | null;
  readonly area: DestinationArea;
  /** Present on, and only on, the eight entries the navigation rail renders. */
  readonly icon?: CmsIconName;
  /** Which Administration group renders it. Present on that area's entries. */
  readonly group?: AdminGroup;
  /** What a person might type instead of the label. Lower case, matched whole. */
  readonly keywords?: readonly string[];
  /**
   * Kept out of page search, and out of it for a reason worth stating.
   *
   * A destination that is a redirect, a duplicate route for the same screen or
   * a thing nobody navigates to by name is noise in a result list. It is still
   * a real page and is still reachable; it is simply not offered as an answer
   * to "where do I go".
   */
  readonly unsearchable?: boolean;
}

/**
 * THE RAIL IS THE FIRST EIGHT, AND IT STAYS EIGHT.
 *
 * Everyday work at the top level, everything else owned by the module it
 * belongs to. Leads is not a rail entry because CRM is; Users is not one
 * because Administration is. A rail listing every screen is a table of
 * contents, and a table of contents is what people read when they cannot
 * navigate.
 *
 * TWO LABELS CHANGED HERE AND NOTHING ELSE DID. "Data" and "Performance" name
 * the implementation rather than the errand: nobody arrives at work meaning to
 * do data. The routes are production contracts and are untouched — `/app/data`
 * is still `/app/data` — because a label is what a person reads and a path is
 * what a bookmark holds, and only one of those was wrong.
 */
export const CMS_DESTINATIONS: readonly CmsDestination[] = [
  // ---- the rail ------------------------------------------------------------
  { label: 'Home', href: '/app', permission: null, area: 'Main', icon: 'home' },
  {
    label: 'Customers',
    href: '/app/operations/customers',
    permission: 'CUSTOMERS.ACCOUNTS.VIEW',
    area: 'Main',
    icon: 'customers',
    keywords: ['accounts', 'contacts', 'clients'],
  },
  {
    label: 'CRM',
    href: '/app/crm',
    permission: 'CRM.LEADS.VIEW',
    area: 'Main',
    icon: 'crm',
    keywords: ['leads', 'sales', 'pipeline'],
  },
  {
    label: 'Helpdesk',
    href: '/app/helpdesk',
    permission: 'SERVICE.CASES.VIEW',
    area: 'Main',
    icon: 'service',
    keywords: ['cases', 'service', 'support', 'tickets'],
  },
  {
    label: 'Orders',
    href: '/app/orders',
    permission: 'ORDERS.SALES_ORDER.VIEW',
    area: 'Main',
    icon: 'orders',
    keywords: ['sales orders', 'purchase orders'],
  },
  {
    label: 'SLA Monitor',
    href: '/app/performance',
    permission: 'SLA.DASHBOARD.VIEW',
    area: 'Main',
    icon: 'performance',
    keywords: ['performance', 'sla', 'breaches', 'turnaround'],
  },
  {
    label: 'Upload Centre',
    href: '/app/data',
    permission: 'DATA.IMPORTS.VIEW',
    area: 'Main',
    icon: 'data',
    keywords: ['data', 'import', 'imports', 'excel', 'extract', 'upload'],
  },
  {
    label: 'Administration',
    href: '/app/administration',
    permission: [
      'ADMIN.USERS.MANAGE',
      'ADMIN.ORGANISATION.VIEW',
      'ADMIN.ORGANISATION.MANAGE',
      'ADMIN.ROLES.MANAGE',
      'ADMIN.WORKFLOWS.MANAGE',
      'ADMIN.WORKFLOW_ROLES.MANAGE',
      'ADMIN.PRODUCT_CATALOG.MANAGE',
    ],
    area: 'Main',
    icon: 'administration',
    keywords: ['settings', 'configuration', 'admin'],
  },

  // ---- CRM -----------------------------------------------------------------
  {
    label: 'Leads',
    href: '/app/crm',
    permission: 'CRM.LEADS.VIEW',
    area: 'CRM',
    keywords: ['enquiries', 'prospects'],
  },
  {
    label: 'Opportunities',
    href: '/app/crm/opportunities',
    permission: 'CRM.OPPORTUNITIES.VIEW',
    area: 'CRM',
    keywords: ['deals', 'pipeline'],
  },
  { label: 'Activities', href: '/app/crm/activities', permission: 'CRM.LEADS.VIEW', area: 'CRM' },
  {
    label: 'CRM analytics',
    href: '/app/crm/analytics',
    permission: 'CRM.OPPORTUNITIES.VIEW',
    area: 'CRM',
    keywords: ['conversion', 'funnel'],
  },
  {
    label: 'Lead sources',
    href: '/app/crm/lead-sources',
    permission: 'CRM.LEAD_SOURCES.MANAGE',
    area: 'CRM',
    keywords: ['campaigns', 'channels'],
  },
  {
    label: 'Pipelines',
    href: '/app/crm/pipelines',
    permission: 'CRM.PIPELINES.MANAGE',
    area: 'CRM',
    keywords: ['stages'],
  },
  {
    label: 'Lost reasons',
    href: '/app/crm/lost-reasons',
    permission: 'CRM.LOST_REASONS.MANAGE',
    area: 'CRM',
  },

  // ---- Helpdesk ------------------------------------------------------------
  {
    label: 'Helpdesk analytics',
    href: '/app/helpdesk/analytics',
    permission: 'SERVICE.CASES.VIEW',
    area: 'Helpdesk',
    keywords: ['case analytics', 'resolution'],
  },
  {
    label: 'Case categories',
    href: '/app/helpdesk/categories',
    permission: 'SERVICE.CATEGORIES.MANAGE',
    area: 'Helpdesk',
  },
  {
    label: 'Case review',
    href: '/app/helpdesk/review',
    permission: 'SERVICE.CASES.VIEW',
    area: 'Helpdesk',
    keywords: ['classification', 'assistant'],
  },

  // ---- Orders --------------------------------------------------------------
  {
    label: 'Sales orders',
    href: '/app/orders/sales',
    permission: 'ORDERS.SALES_ORDER.VIEW',
    area: 'Orders',
    keywords: ['so', 'operations'],
  },
  {
    label: 'Sales order performance',
    href: '/app/orders/sales/performance',
    permission: 'ORDERS.SALES_ORDER.VIEW',
    area: 'Orders',
    keywords: ['so performance', 'turnaround'],
  },
  {
    label: 'Purchase orders',
    href: '/app/orders/purchases',
    permission: 'ORDERS.PURCHASE_ORDER.VIEW',
    area: 'Orders',
    keywords: ['po', 'operations'],
  },
  {
    label: 'Purchase order performance',
    href: '/app/orders/purchases/performance',
    permission: 'ORDERS.PURCHASE_ORDER.VIEW',
    area: 'Orders',
    keywords: ['po performance', 'turnaround'],
  },

  // ---- SLA Monitor ---------------------------------------------------------
  {
    label: 'Approval performance',
    href: '/app/performance/approvals',
    permission: 'SLA.DASHBOARD.VIEW',
    area: 'SLA Monitor',
    keywords: ['approvals', 'cycle time'],
  },
  {
    label: 'Reports',
    href: '/app/performance/reports',
    permission: 'SLA.DASHBOARD.VIEW',
    area: 'SLA Monitor',
    keywords: ['export', 'csv'],
  },
  {
    label: 'SLA rules',
    href: '/app/administration/sla',
    permission: 'SLA.RULES.MANAGE',
    area: 'SLA Monitor',
    keywords: ['calendars', 'profiles', 'targets'],
  },

  // ---- Upload Centre -------------------------------------------------------
  {
    label: 'Upload a file',
    href: '/app/data/upload',
    permission: 'DATA.IMPORTS.UPLOAD',
    area: 'Upload Centre',
    keywords: ['import', 'excel'],
  },
  {
    label: 'Import history',
    href: '/app/data/history',
    permission: 'DATA.IMPORTS.VIEW',
    area: 'Upload Centre',
    keywords: ['batches', 'previous imports'],
  },
  {
    label: 'Import exceptions',
    href: '/app/data/exceptions',
    permission: 'DATA.IMPORTS.VIEW',
    area: 'Upload Centre',
    keywords: ['rejected rows', 'errors'],
  },
  {
    label: 'Unresolved actors',
    href: '/app/data/review',
    permission: 'DATA.IMPORTS.VIEW',
    area: 'Upload Centre',
    keywords: ['unmatched people', 'source identities'],
  },

  // ---- Administration ------------------------------------------------------
  {
    label: 'Users',
    href: '/app/administration/users',
    permission: 'ADMIN.USERS.MANAGE',
    area: 'Administration',
    group: 'People & access',
    keywords: ['people', 'staff', 'accounts'],
  },
  {
    label: 'Job titles',
    href: '/app/administration/users/job-titles',
    permission: 'ADMIN.USERS.MANAGE',
    area: 'Administration',
    group: 'People & access',
    keywords: ['positions', 'title mappings'],
  },
  {
    label: 'Organisation',
    href: ORGANISATION_PATH,
    permission: ['ADMIN.ORGANISATION.VIEW', 'ADMIN.ORGANISATION.MANAGE'],
    area: 'Administration',
    group: 'People & access',
    keywords: ['countries', 'affiliates', 'business units', 'departments', 'teams'],
  },
  {
    label: 'Roles and permissions',
    href: '/app/administration/roles',
    permission: 'ADMIN.ROLES.MANAGE',
    area: 'Administration',
    group: 'People & access',
    keywords: ['access roles', 'rbac', 'permissions'],
  },
  {
    label: 'Access review',
    href: '/app/administration/access-review',
    permission: ['ADMIN.USERS.MANAGE', 'ADMIN.WORKFLOW_ROLES.MANAGE'],
    area: 'Administration',
    group: 'People & access',
    keywords: ['who holds what', 'entitlement review'],
  },
  {
    label: 'Workflow authority review',
    href: '/app/administration/authority',
    permission: ['ADMIN.USERS.MANAGE', 'ADMIN.WORKFLOW_ROLES.MANAGE'],
    area: 'Administration',
    group: 'People & access',
    keywords: ['approvers', 'approval authority'],
  },
  {
    label: 'Workflows',
    href: WORKFLOW_PATH,
    permission: ['ADMIN.WORKFLOWS.MANAGE', 'ADMIN.WORKFLOW_ROLES.MANAGE'],
    area: 'Administration',
    group: 'Process & configuration',
    keywords: ['approval stages', 'process', 'workflow roles'],
  },
  {
    label: 'Product catalogue',
    href: '/app/administration/catalogue',
    permission: 'ADMIN.PRODUCT_CATALOG.MANAGE',
    area: 'Administration',
    group: 'Process & configuration',
    keywords: ['products', 'groups', 'categories'],
  },
  {
    label: 'Channels',
    href: '/app/administration/channels',
    permission: 'ADMIN.USERS.MANAGE',
    area: 'Administration',
    group: 'Process & configuration',
    keywords: ['whatsapp', 'email', 'connections'],
  },
  {
    label: 'AI',
    href: '/app/administration/ai',
    permission: 'ADMIN.USERS.MANAGE',
    area: 'Administration',
    group: 'Process & configuration',
    keywords: ['assistant', 'providers', 'models'],
  },
  {
    label: 'Audit trail',
    href: '/app/administration/audit',
    permission: 'AUDIT.EVENTS.VIEW',
    area: 'Administration',
    group: 'Assurance & system',
    keywords: ['log', 'history', 'events', 'who changed what'],
  },
  {
    label: 'System health',
    href: '/app/administration/health',
    permission: ['ADMIN.USERS.MANAGE', 'ADMIN.WORKFLOW_ROLES.MANAGE'],
    area: 'Administration',
    group: 'Assurance & system',
    keywords: ['status', 'checks', 'schema'],
  },
  {
    label: 'Design reference',
    href: '/app/administration/components',
    permission: 'ADMIN.USERS.MANAGE',
    area: 'Administration',
    group: 'Advanced',
    keywords: ['components', 'design system', 'tokens'],
  },
];

/** Whether a principal's codes satisfy one destination's requirement. */
export function destinationAllowed(
  destination: Pick<CmsDestination, 'permission'>,
  permissions: readonly string[],
): boolean {
  if (destination.permission === null) return true;
  if (typeof destination.permission === 'string') {
    return permissions.includes(destination.permission);
  }
  return destination.permission.some((code) => permissions.includes(code));
}

/** The Administration destinations this caller may see, in their groups. */
export function adminGroups(
  permissions: readonly string[],
): { group: AdminGroup; entries: CmsDestination[] }[] {
  return ADMIN_GROUP_ORDER.map((group) => ({
    group,
    entries: CMS_DESTINATIONS.filter(
      (d) => d.area === 'Administration' && d.group === group && destinationAllowed(d, permissions),
    ),
  })).filter((section) => section.entries.length > 0);
}

/** Every destination this caller may see, whatever its area. */
export function allowedDestinations(permissions: readonly string[]): CmsDestination[] {
  return CMS_DESTINATIONS.filter(
    (d) => d.unsearchable !== true && destinationAllowed(d, permissions),
  );
}
