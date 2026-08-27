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
  canManageOrganisation,
  canManageRoles,
  canManageUsers,
  canManageWorkflowRoles,
  canManageWorkflows,
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
