/**
 * The permission codes this product authorises against, named once.
 *
 * A code is a string in the database's own MODULE.RESOURCE.ACTION form. Naming
 * them here rather than typing the literal at each call site is not tidiness:
 * a mistyped literal is a silent grant failure that looks like a working guard,
 * because `permissions.includes('ADMIN.ORGANISATON.MANAGE')` is false for
 * everybody and refuses everybody, which is indistinguishable from correct
 * behaviour until an administrator complains.
 *
 * These two do not exist in the seeded `permissions` table. They are added by
 * docs/cms/organisation/01_add_organisation_permissions.sql, which the operator
 * runs by hand in the Turso console. Until then every endpoint below refuses
 * every caller, which is the correct direction to fail.
 */

/** Read countries, affiliates, business units, departments and teams. */
export const ORGANISATION_VIEW = 'ADMIN.ORGANISATION.VIEW';

/** Create, edit and deactivate that master data. */
export const ORGANISATION_MANAGE = 'ADMIN.ORGANISATION.MANAGE';

/**
 * MANAGE implies VIEW.
 *
 * Not because the database says so, and it does not: the two rows are
 * independent and a role could be granted MANAGE alone. It is stated here
 * because a workspace that let someone edit a country they could not read would
 * be incoherent, and because the alternative is every read path checking two
 * codes and one of them eventually forgetting.
 */
export function canViewOrganisation(permissions: readonly string[]): boolean {
  return permissions.includes(ORGANISATION_VIEW) || permissions.includes(ORGANISATION_MANAGE);
}

export function canManageOrganisation(permissions: readonly string[]): boolean {
  return permissions.includes(ORGANISATION_MANAGE);
}

/**
 * User administration. Already in the seeded catalogue as PERM-016, already
 * granted to ROLE-ADMIN, so Build Prompt 06 needs no data script.
 */
export const USERS_MANAGE = 'ADMIN.USERS.MANAGE';

export function canManageUsers(permissions: readonly string[]): boolean {
  return permissions.includes(USERS_MANAGE);
}

/**
 * Role and permission administration. Already in the seeded catalogue as
 * PERM-015, already granted to ROLE-ADMIN, so Build Prompt 07 needs no data
 * script either.
 */
export const ROLES_MANAGE = 'ADMIN.ROLES.MANAGE';

export function canManageRoles(permissions: readonly string[]): boolean {
  return permissions.includes(ROLES_MANAGE);
}

/**
 * Workflow definitions and stages. Already in the seeded catalogue as PERM-017
 * and already granted to ROLE-ADMIN, so Build Prompt 08 needs no data script.
 */
export const WORKFLOWS_MANAGE = 'ADMIN.WORKFLOWS.MANAGE';

export function canManageWorkflows(permissions: readonly string[]): boolean {
  return permissions.includes(WORKFLOWS_MANAGE);
}

/**
 * Workflow roles, their scoped assignments and the authority rules that
 * restrict them. PERM-021, also already granted to ROLE-ADMIN.
 *
 * Separate from WORKFLOWS_MANAGE because the schema separates them, and the
 * separation is meaningful: designing a workflow decides what steps a
 * transaction goes through, while assigning a workflow role decides who may
 * approve and for how much. An organisation can reasonably give one of those to
 * a process owner and keep the other with finance.
 */
export const WORKFLOW_ROLES_MANAGE = 'ADMIN.WORKFLOW_ROLES.MANAGE';

export function canManageWorkflowRoles(permissions: readonly string[]): boolean {
  return permissions.includes(WORKFLOW_ROLES_MANAGE);
}

/**
 * Reading workflow configuration: the definitions list, a role's assignments,
 * the approval preview. Either manage permission is enough, because both halves
 * of the configuration have to be legible to make sense of the other.
 */
export function canViewWorkflows(permissions: readonly string[]): boolean {
  return canManageWorkflows(permissions) || canManageWorkflowRoles(permissions);
}

/**
 * The shared product catalogue: groups, categories and products.
 *
 * PERM-028 in the seeded catalogue, already granted to ROLE-ADMIN, so Build
 * Prompt 09 needs no data script either.
 *
 * One permission for the whole catalogue rather than a read tier and a write
 * tier, for the same reason ADMIN.USERS.MANAGE is one: there is no
 * ADMIN.PRODUCT_CATALOG.VIEW in the seeded `permissions` table, so a reader
 * tier would be a code nothing grants and nobody could ever hold.
 */
export const PRODUCT_CATALOGUE_MANAGE = 'ADMIN.PRODUCT_CATALOG.MANAGE';

export function canManageCatalogue(permissions: readonly string[]): boolean {
  return permissions.includes(PRODUCT_CATALOGUE_MANAGE);
}

/**
 * The customer account: the spine every other module hangs off.
 *
 * Added by docs/cms/customers/02_add_customer_permissions.sql as PERM-031 to
 * PERM-033, which the operator runs by hand. The seeded catalogue has no
 * CUSTOMERS module at all, so until that script runs every customer endpoint
 * refuses every caller, which is the correct direction to fail.
 *
 * The navigation model has named CUSTOMERS.ACCOUNTS.VIEW since Build Prompt 02.
 * That reference resolves to a real row for the first time here.
 */
export const ACCOUNTS_VIEW = 'CUSTOMERS.ACCOUNTS.VIEW';
export const ACCOUNTS_MANAGE = 'CUSTOMERS.ACCOUNTS.MANAGE';

/**
 * Whether a contact holds customer portal access, and in which state.
 *
 * Narrow on purpose. It is a fact about an external person's credentials, so it
 * is not bundled into the ordinary customer read most of the organisation
 * holds. It is not PORTAL.ACCOUNT.VIEW (PERM-022), which is what the external
 * customer holds over their own account.
 */
export const PORTAL_ACCESS_VIEW = 'CUSTOMERS.PORTAL_ACCESS.VIEW';

/** MANAGE implies VIEW, for the reason stated on canViewOrganisation. */
export function canViewAccounts(permissions: readonly string[]): boolean {
  return permissions.includes(ACCOUNTS_VIEW) || permissions.includes(ACCOUNTS_MANAGE);
}

export function canManageAccounts(permissions: readonly string[]): boolean {
  return permissions.includes(ACCOUNTS_MANAGE);
}

export function canSeePortalAccess(permissions: readonly string[]): boolean {
  return permissions.includes(PORTAL_ACCESS_VIEW);
}

/**
 * Lead management.
 *
 * VIEW, CREATE and ASSIGN are seeded as PERM-001 to PERM-003. MANAGE and the
 * lead-source settings code are added by
 * docs/cms/crm/03_add_lead_permissions.sql, which the operator runs by hand.
 *
 * MANAGE is separate from CREATE on purpose. The person who takes a web enquiry
 * is often not the person who decides it is qualified, and folding the two
 * together would mean anyone who can log an enquiry can also declare it dead.
 */
export const LEADS_VIEW = 'CRM.LEADS.VIEW';
export const LEADS_CREATE = 'CRM.LEADS.CREATE';
export const LEADS_ASSIGN = 'CRM.LEADS.ASSIGN';
export const LEADS_MANAGE = 'CRM.LEADS.MANAGE';
export const LEAD_SOURCES_MANAGE = 'CRM.LEAD_SOURCES.MANAGE';
export const OPPORTUNITIES_EDIT = 'CRM.OPPORTUNITIES.EDIT';

export function canViewLeads(permissions: readonly string[]): boolean {
  return (
    permissions.includes(LEADS_VIEW) ||
    permissions.includes(LEADS_CREATE) ||
    permissions.includes(LEADS_MANAGE)
  );
}

export function canCreateLeads(permissions: readonly string[]): boolean {
  return permissions.includes(LEADS_CREATE);
}

export function canManageLeads(permissions: readonly string[]): boolean {
  return permissions.includes(LEADS_MANAGE);
}

export function canAssignLeads(permissions: readonly string[]): boolean {
  return permissions.includes(LEADS_ASSIGN);
}

export function canManageLeadSources(permissions: readonly string[]): boolean {
  return permissions.includes(LEAD_SOURCES_MANAGE);
}

/**
 * Conversion writes an opportunity as well as closing the lead, so it needs
 * both codes. Holding one without the other converts nothing.
 */
export function canConvertLeads(permissions: readonly string[]): boolean {
  return permissions.includes(LEADS_MANAGE) && permissions.includes(OPPORTUNITIES_EDIT);
}
