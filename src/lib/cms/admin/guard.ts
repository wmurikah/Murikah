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
import { canManageOrganisation, canManageUsers, canViewOrganisation } from '../permissions.ts';
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
