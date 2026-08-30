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

/**
 * Opportunities and the pipeline.
 *
 * EDIT is seeded as PERM-004. VIEW and the two settings codes are added by
 * docs/cms/crm/04_add_opportunity_permissions.sql, which the operator runs by
 * hand. VIEW is implied by EDIT, in the same way LEADS.VIEW is implied by the
 * lead codes: a person allowed to move a deal can obviously see it.
 *
 * Pipeline configuration is deliberately not part of EDIT. The stages define
 * what history means, and a salesperson able to reorder them mid-quarter
 * would be rewriting every open deal's meaning to improve their own numbers.
 */
export const OPPORTUNITIES_VIEW = 'CRM.OPPORTUNITIES.VIEW';
export const PIPELINES_MANAGE = 'CRM.PIPELINES.MANAGE';
export const LOST_REASONS_MANAGE = 'CRM.LOST_REASONS.MANAGE';

export function canViewOpportunities(permissions: readonly string[]): boolean {
  return permissions.includes(OPPORTUNITIES_VIEW) || permissions.includes(OPPORTUNITIES_EDIT);
}

export function canEditOpportunities(permissions: readonly string[]): boolean {
  return permissions.includes(OPPORTUNITIES_EDIT);
}

export function canManagePipelines(permissions: readonly string[]): boolean {
  return permissions.includes(PIPELINES_MANAGE);
}

export function canManageLostReasons(permissions: readonly string[]): boolean {
  return permissions.includes(LOST_REASONS_MANAGE);
}

/**
 * Customer service.
 *
 * VIEW, CREATE and REASSIGN are seeded as PERM-005 to PERM-007. MANAGE and
 * the category settings code are added by
 * docs/cms/service/05_add_service_permissions.sql, run by the operator.
 * MANAGE is separate from CREATE on purpose: logging a walk-in enquiry and
 * declaring a complaint resolved are different responsibilities.
 */
export const CASES_VIEW = 'SERVICE.CASES.VIEW';
export const CASES_CREATE = 'SERVICE.CASES.CREATE';
export const CASES_REASSIGN = 'SERVICE.CASES.REASSIGN';
export const CASES_MANAGE = 'SERVICE.CASES.MANAGE';
export const CASE_CATEGORIES_MANAGE = 'SERVICE.CATEGORIES.MANAGE';

export function canViewCases(permissions: readonly string[]): boolean {
  return (
    permissions.includes(CASES_VIEW) ||
    permissions.includes(CASES_CREATE) ||
    permissions.includes(CASES_MANAGE)
  );
}

export function canCreateCases(permissions: readonly string[]): boolean {
  return permissions.includes(CASES_CREATE);
}

export function canReassignCases(permissions: readonly string[]): boolean {
  return permissions.includes(CASES_REASSIGN);
}

export function canManageCases(permissions: readonly string[]): boolean {
  return permissions.includes(CASES_MANAGE);
}

export function canManageCaseCategories(permissions: readonly string[]): boolean {
  return permissions.includes(CASE_CATEGORIES_MANAGE);
}

/**
 * The SLA runtime. Both codes are seeded: PERM-013 reads the monitor,
 * PERM-014 configures calendars, profiles and rules.
 */
export const SLA_DASHBOARD_VIEW = 'SLA.DASHBOARD.VIEW';
export const SLA_RULES_MANAGE = 'SLA.RULES.MANAGE';

export function canViewSlaDashboard(permissions: readonly string[]): boolean {
  return permissions.includes(SLA_DASHBOARD_VIEW) || permissions.includes(SLA_RULES_MANAGE);
}

export function canManageSlaRules(permissions: readonly string[]): boolean {
  return permissions.includes(SLA_RULES_MANAGE);
}

/**
 * Data ingestion. Four seeded codes, and the pairing matters.
 *
 * PERM-019 says a person may run an import at all. PERM-009 and PERM-011 say
 * which kind of extract they may put into the product. An upload is checked
 * against both, because "may use the Upload Centre" and "may load purchase
 * orders" are different permissions and the seeded catalogue already draws
 * that line. Nothing here reads a job title, a department or a role name:
 * the finance manager who runs the monthly extract holds the codes, and a
 * person who does not hold them is refused however senior their title.
 *
 * PERM-019, PERM-009 and PERM-011 reach ROLE-ADMIN through the seed's
 * grant-everything insert. Granting them to the finance roles that actually
 * run the monthly upload is data, not code:
 * docs/cms/data/06_add_import_grants.sql.
 */
export const IMPORTS_VIEW = 'DATA.IMPORTS.VIEW';
export const IMPORTS_UPLOAD = 'DATA.IMPORTS.UPLOAD';
export const SALES_ORDER_VIEW = 'ORDERS.SALES_ORDER.VIEW';
export const SALES_ORDER_UPLOAD = 'ORDERS.SALES_ORDER.UPLOAD';
export const PURCHASE_ORDER_VIEW = 'ORDERS.PURCHASE_ORDER.VIEW';
export const PURCHASE_ORDER_UPLOAD = 'ORDERS.PURCHASE_ORDER.UPLOAD';

/**
 * The executive dashboard, as a home rather than as a door.
 *
 * A DEDICATED CODE, not the union of the four the page composes from. The nav
 * gates the Executive link on holding ANY of the four module codes, which is
 * the right question for "may this person open the page": the page composes
 * itself from whatever they hold, so someone with one code sees the one
 * section their code covers, and that is useful.
 *
 * It is the wrong question for "is this page their home". Landing a person
 * holding only SERVICE.CASES.VIEW on a dashboard where five of six sections
 * are composed away is a worse first screen than Home, and nobody chose it for
 * them. This code says somebody decided this person's job starts here.
 *
 * Added as PERM-041 by docs/cms/executive/08_add_executive_permission.sql,
 * which the operator runs. Until it is run nobody holds the code and everybody
 * lands on Home, which is exactly today's behaviour: the default of this
 * change is no change.
 */
export const EXECUTIVE_DASHBOARD_VIEW = 'EXECUTIVE.DASHBOARD.VIEW';

export function canViewExecutiveDashboard(permissions: readonly string[]): boolean {
  return permissions.includes(EXECUTIVE_DASHBOARD_VIEW);
}

export function canViewImports(permissions: readonly string[]): boolean {
  return permissions.includes(IMPORTS_VIEW) || permissions.includes(IMPORTS_UPLOAD);
}

export function canUploadImports(permissions: readonly string[]): boolean {
  return permissions.includes(IMPORTS_UPLOAD);
}

export function canViewSalesOrders(permissions: readonly string[]): boolean {
  return permissions.includes(SALES_ORDER_VIEW);
}

export function canViewPurchaseOrders(permissions: readonly string[]): boolean {
  return permissions.includes(PURCHASE_ORDER_VIEW);
}

/**
 * Both codes, never one. The Upload Centre is one door; what may come
 * through it is decided per data type.
 */
export function canUploadImportType(
  permissions: readonly string[],
  importType: 'SALES_ORDER' | 'PURCHASE_ORDER',
): boolean {
  if (!canUploadImports(permissions)) return false;
  return permissions.includes(
    importType === 'SALES_ORDER' ? SALES_ORDER_UPLOAD : PURCHASE_ORDER_UPLOAD,
  );
}

/**
 * Credit exception approval, seeded as PERM-012.
 *
 * Phase 20 reuses it as the gate on credit INFORMATION as well as on the
 * decision, because credit limits, terms and exception reasons are
 * commercially sensitive and a person who may not act on them has no reason
 * to read them customer by customer. The conservative reading: a caller
 * without this code sees the operational columns and no credit analysis,
 * rather than an empty column that hints at what is behind it.
 */
export const CREDIT_EXCEPTION_APPROVE = 'CREDIT.EXCEPTION.APPROVE';

export function canSeeCreditInformation(permissions: readonly string[]): boolean {
  return permissions.includes(CREDIT_EXCEPTION_APPROVE);
}

/**
 * Audit, and the two codes phase 26 needs that the catalogue does not have.
 *
 * `AUDIT.EVENTS.VIEW` is PERM-020 and is already held by the affiliate and
 * group finance roles, because a finance manager reviewing an approval needs
 * to see what happened to the order.
 *
 * The other two do not exist in the seeded catalogue and are delivered as
 * `docs/cms/audit/09_add_audit_permissions.sql` for the operator to run.
 * Until they do, `resolveScope` finds no permission row, returns not-granted,
 * and the security view and the audit export refuse everybody including the
 * system administrator. That is correct: the permissions table is the
 * authority, and a code that does not exist grants nothing. Both surfaces say
 * so by name rather than rendering an empty screen.
 *
 * SECURITY_VIEW is separate from VIEW because reading what happened to an
 * order is not the same as reading sign-in failures, password resets, role
 * grants and scope changes, which are investigative material about people.
 * EXPORT is separate from both because carrying evidence out of the building
 * is a different act from reading it on screen, and it is the one path by
 * which audit content leaves the controls that protect it.
 */
export const AUDIT_VIEW = 'AUDIT.EVENTS.VIEW';
export const AUDIT_SECURITY_VIEW = 'AUDIT.EVENTS.SECURITY_VIEW';
export const AUDIT_EXPORT = 'AUDIT.EVENTS.EXPORT';

export function canViewAudit(permissions: readonly string[]): boolean {
  return permissions.includes(AUDIT_VIEW);
}

/** Never implied by VIEW. See above. */
export function canViewSecurityAudit(permissions: readonly string[]): boolean {
  return permissions.includes(AUDIT_SECURITY_VIEW);
}

/** Never implied by VIEW or by SECURITY_VIEW. */
export function canExportAudit(permissions: readonly string[]): boolean {
  return permissions.includes(AUDIT_EXPORT);
}
