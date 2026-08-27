/**
 * The tab model for the Administration → Organisation workspace.
 *
 * Data rather than markup, for the same reason the navigation is: five tabs
 * hard-coded into a template cannot be filtered, reordered or counted without
 * being rewritten. Each tab is a real URL, so it can be bookmarked, opened in a
 * new browser tab and survives a reload without any client-side state.
 */
export const ORGANISATION_PATH = '/app/administration/organisation';

export type OrganisationTabKey =
  | 'countries'
  | 'affiliates'
  | 'business-units'
  | 'departments'
  | 'teams';

export interface OrganisationTab {
  readonly key: OrganisationTabKey;
  readonly label: string;
  /** Singular, for the create button and the drawer heading. */
  readonly singular: string;
  /** The collection endpoint these rows are written through. */
  readonly endpoint: string;
}

export const ORGANISATION_TABS: readonly OrganisationTab[] = [
  {
    key: 'countries',
    label: 'Countries',
    singular: 'country',
    endpoint: '/api/admin/countries',
  },
  {
    key: 'affiliates',
    label: 'Affiliates',
    singular: 'affiliate',
    endpoint: '/api/admin/affiliates',
  },
  {
    key: 'business-units',
    label: 'Business units',
    singular: 'business unit',
    endpoint: '/api/admin/business-units',
  },
  {
    key: 'departments',
    label: 'Departments',
    singular: 'department',
    endpoint: '/api/admin/departments',
  },
  { key: 'teams', label: 'Teams', singular: 'team', endpoint: '/api/admin/teams' },
];

/** The requested tab, or the first one. An unknown value is not an error. */
export function resolveTab(raw: string | null): OrganisationTab {
  const found = ORGANISATION_TABS.find((tab) => tab.key === raw);
  return found ?? (ORGANISATION_TABS[0] as OrganisationTab);
}

export function tabHref(key: OrganisationTabKey): string {
  return `${ORGANISATION_PATH}?tab=${key}`;
}

/**
 * The status filter, as three states rather than a boolean.
 *
 * `all` is the default. Deactivation is not deletion in this product, and a
 * list that hid inactive rows by default would make a deactivated country look
 * like a missing one, which is how somebody creates a duplicate.
 */
export type StatusFilter = 'all' | 'active' | 'inactive';

export function resolveStatus(raw: string | null): StatusFilter {
  return raw === 'active' || raw === 'inactive' ? raw : 'all';
}

export function matchesStatus(active: boolean, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'active' ? active : !active;
}

/** Case-insensitive, accent-naive substring search across the given fields. */
export function matchesSearch(query: string, ...fields: (string | null)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return fields.some((field) => (field ?? '').toLowerCase().includes(needle));
}
