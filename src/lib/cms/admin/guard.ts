/**
 * The server-side authorisation every administration endpoint runs first.
 *
 * Hidden UI is not access control. The navigation filter in @/lib/cms/nav is
 * presentation: it decides what a menu offers, and stops nobody from typing a
 * URL or posting with curl. This is the control, and it runs before a row is
 * read and before a write is attempted.
 *
 * The decision is made on the resolved permission codes on the principal and on
 * nothing else. Not an email address, not a display name, not a job title, not
 * a department, not an employee number, not a hard-coded user id, not a
 * hard-coded role id. Every one of those is a property that changes for reasons
 * that have nothing to do with access, and every one of them has to be found
 * and corrected by hand when it does.
 *
 * The principal itself comes from the Build Prompt 04 middleware guard, which
 * has already verified the session cookie against `auth_sessions` and loaded
 * the identity. An endpoint never resolves a session for itself.
 */
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../repos/identity.ts';
import {
  canAssignLeads,
  canConvertLeads,
  canCreateLeads,
  canManageAccounts,
  canManageCatalogue,
  canManageLeadSources,
  canViewOpportunities,
  canEditOpportunities,
  canManagePipelines,
  canManageLostReasons,
  canViewCases,
  canCreateCases,
  canReassignCases,
  canManageCases,
  canManageCaseCategories,
  canViewSlaDashboard,
  canManageSlaRules,
  canManageLeads,
  canManageOrganisation,
  canManageRoles,
  canManageUsers,
  canManageWorkflowRoles,
  canManageWorkflows,
  canViewAccounts,
  canViewLeads,
  canViewOrganisation,
  canViewWorkflows,
} from '../permissions.ts';
import { forbidden, unauthorised } from '../errors.ts';
import { clientIp } from '../../http.ts';

export interface AdminPrincipal {
  readonly sessionId: string;
  readonly user: CmsIdentity;
}

/**
 * Either the authorised principal, or the response to return instead.
 *
 * A discriminated union rather than a thrown error or a null, so a call site
 * that forgets to handle the refusal does not compile. An endpoint cannot
 * accidentally continue past a denial.
 */
export type Authorisation =
  | { readonly ok: true; readonly principal: AdminPrincipal }
  | { readonly ok: false; readonly response: Response };

type Check = (permissions: readonly string[]) => boolean;

function authorise(context: APIContext, allowed: Check): Authorisation {
  const principal = context.locals.cms;
  // No session at all. The middleware lets an API request through unredirected
  // precisely so the endpoint can say this in JSON.
  if (!principal) return { ok: false, response: unauthorised() };

  if (!allowed(principal.user.permissions)) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, principal: { sessionId: principal.sessionId, user: principal.user } };
}

/** Reading organisation master data. MANAGE implies it; see @/lib/cms/permissions. */
export function requireOrganisationView(context: APIContext): Authorisation {
  return authorise(context, canViewOrganisation);
}

/** Changing organisation master data. */
export function requireOrganisationManage(context: APIContext): Authorisation {
  return authorise(context, canManageOrganisation);
}

/**
 * User administration: creating users, altering assignments, suspending,
 * reactivating, changing an email, mapping a source identity.
 *
 * One permission for the whole of it, which is what the seeded catalogue
 * offers: there is no ADMIN.USERS.VIEW, so a reader-only tier would be a code
 * that nothing in the database grants and nobody could ever hold.
 */
export function requireUsersManage(context: APIContext): Authorisation {
  return authorise(context, canManageUsers);
}

/**
 * Role and permission administration.
 *
 * This is the permission the last-administrator guard protects: the capability
 * to grant capabilities. Losing every holder of it is unrecoverable through the
 * interface, which is why @/lib/cms/repos/rbacAdmin refuses the operation that
 * would rather than trusting a confirmation dialogue.
 */
export function requireRolesManage(context: APIContext): Authorisation {
  return authorise(context, canManageRoles);
}

/**
 * Workflow definitions and stages: what steps a transaction goes through.
 */
export function requireWorkflowsManage(context: APIContext): Authorisation {
  return authorise(context, canManageWorkflows);
}

/**
 * Workflow roles, scoped assignments and authority rules: who may approve, for
 * which organisation, and up to what value.
 *
 * This is the permission that grants approval authority, so it is the one an
 * escalation attack wants. It is checked on every write below it, including the
 * deliberate re-resolution of a started stage, because re-resolving a stage
 * against changed configuration reaches the same outcome as editing the
 * assignment directly.
 */
export function requireWorkflowRolesManage(context: APIContext): Authorisation {
  return authorise(context, canManageWorkflowRoles);
}

/**
 * Reading a customer account and its contacts.
 *
 * This is the widest read in the product: a service agent opening a case, a
 * finance approver checking an order and a country manager reading a pipeline
 * all need the account behind the record. It is a permission check only; which
 * accounts the caller may then see is decided by the Build Prompt 07 scope
 * resolver, and the two are not the same question.
 */
export function requireAccountsView(context: APIContext): Authorisation {
  return authorise(context, canViewAccounts);
}

/** Creating and editing accounts and contacts. */
export function requireAccountsManage(context: APIContext): Authorisation {
  return authorise(context, canManageAccounts);
}

/**
 * Reading a lead. CREATE and MANAGE both imply it, because a person who may
 * log an enquiry or qualify one has no coherent reason to be unable to read it.
 */
export function requireLeadsView(context: APIContext): Authorisation {
  return authorise(context, canViewLeads);
}

/** Logging a new lead. */
export function requireLeadsCreate(context: APIContext): Authorisation {
  return authorise(context, canCreateLeads);
}

/** Editing, recording first contact, qualifying and disqualifying. */
export function requireLeadsManage(context: APIContext): Authorisation {
  return authorise(context, canManageLeads);
}

/** Changing a lead's owner. Its own code in the seeded catalogue. */
export function requireLeadsAssign(context: APIContext): Authorisation {
  return authorise(context, canAssignLeads);
}

/**
 * Converting a lead to an opportunity, which needs both codes because it
 * writes both records. Holding one without the other converts nothing.
 */
export function requireLeadConvert(context: APIContext): Authorisation {
  return authorise(context, canConvertLeads);
}

/** The lead source settings screen. */
export function requireLeadSourcesManage(context: APIContext): Authorisation {
  return authorise(context, canManageLeadSources);
}

/** Reading the pipeline and the opportunity list. Implied by EDIT. */
export function requireOpportunitiesView(context: APIContext): Authorisation {
  return authorise(context, canViewOpportunities);
}

/** Creating, editing and moving opportunities. */
export function requireOpportunitiesEdit(context: APIContext): Authorisation {
  return authorise(context, canEditOpportunities);
}

/**
 * Pipeline and stage configuration. Administrative on purpose: the stages
 * define what every deal's history means, so this is never granted with EDIT
 * as a package.
 */
export function requirePipelinesManage(context: APIContext): Authorisation {
  return authorise(context, canManagePipelines);
}

/** The lost reason settings screen. */
export function requireLostReasonsManage(context: APIContext): Authorisation {
  return authorise(context, canManageLostReasons);
}

/** Reading the case queue and a case. Implied by CREATE and MANAGE. */
export function requireCasesView(context: APIContext): Authorisation {
  return authorise(context, canViewCases);
}

/** Logging a new case. */
export function requireCasesCreate(context: APIContext): Authorisation {
  return authorise(context, canCreateCases);
}

/** Assigning and reassigning. Its own seeded code, PERM-007. */
export function requireCasesReassign(context: APIContext): Authorisation {
  return authorise(context, canReassignCases);
}

/** Working a case: status, communications, resolve, close, cancel, reopen. */
export function requireCasesManage(context: APIContext): Authorisation {
  return authorise(context, canManageCases);
}

/** The case category settings screen. */
export function requireCaseCategoriesManage(context: APIContext): Authorisation {
  return authorise(context, canManageCaseCategories);
}

/** Reading the SLA monitor. Implied by the configuration code. */
export function requireSlaDashboard(context: APIContext): Authorisation {
  return authorise(context, canViewSlaDashboard);
}

/** Configuring calendars, profiles and rules. */
export function requireSlaRulesManage(context: APIContext): Authorisation {
  return authorise(context, canManageSlaRules);
}

/**
 * The shared product catalogue.
 *
 * The catalogue is read by leads, opportunities, orders, cases, SLA analytics
 * and Build Prompt 08's authority rules, so a change here reaches every module
 * at once. Enforced on the endpoint before any write and before any row is
 * returned: hidden UI is not access control.
 */
export function requireCatalogueManage(context: APIContext): Authorisation {
  return authorise(context, canManageCatalogue);
}

/** Reading workflow configuration and running the approval preview. */
export function requireWorkflowView(context: APIContext): Authorisation {
  return authorise(context, canViewWorkflows);
}

/**
 * A signed-in principal, with no permission requirement.
 *
 * Used by the decision endpoint, and by nothing else. Approving is not an
 * administration permission: authority to approve comes from being an assignee
 * of that stage instance, which ../workflow/runtime.ts checks against the
 * session. A permission code here would be a second, weaker answer to a
 * question the stage already answers precisely.
 */
export function requireSignedIn(context: APIContext): Authorisation {
  return authorise(context, () => true);
}

/**
 * The request context an audit row records alongside the change.
 *
 * Collected here rather than in each endpoint so no write can quietly omit it.
 * The address comes from the same `clientIp` helper the sign-in path uses, so
 * an administration audit row and an authentication audit row record the caller
 * the same way and can be read together.
 */
export interface WriteContext {
  readonly actorUserId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

export function writeContext(request: Request, principal: AdminPrincipal): WriteContext {
  return {
    actorUserId: principal.user.userId,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent'),
    now: new Date(),
  };
}
