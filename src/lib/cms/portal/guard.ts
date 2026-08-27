/**
 * The portal's own authorisation, separate from the internal one.
 *
 * An internal endpoint asks "does this principal hold this permission
 * code". A portal endpoint asks a different question: "is this an external
 * user with a live membership, and which accounts does it name". Answering
 * the first question here would be wrong, because an external user holds
 * portal permission codes that say nothing about which customer they are.
 *
 * There is one entry point. An endpoint that forgot to call it would have no
 * scope object to query with, which is the point: the scope is the only way
 * to build a portal query at all.
 */
import type { APIContext } from 'astro';
import type { Client } from '@libsql/client/web';
import { portalScope, type PortalScope } from './tenant.ts';
import { unauthorised, forbidden } from '../errors.ts';

export type PortalAuthorisation =
  | { readonly ok: true; readonly scope: PortalScope }
  | { readonly ok: false; readonly response: Response };

export async function requirePortal(context: APIContext, db: Client): Promise<PortalAuthorisation> {
  const principal = context.locals.cms;
  if (!principal) return { ok: false, response: unauthorised() };
  const requested = context.url.searchParams.get('accountId');
  const access = await portalScope(db, principal.user, requested);
  if (!access.ok) {
    // An internal user reaching a portal endpoint and an external user with
    // no live membership both get the same refusal. Neither is told which.
    return { ok: false, response: forbidden() };
  }
  return { ok: true, scope: access.scope };
}

/**
 * The same authorisation for a page rather than an endpoint.
 *
 * A page cannot answer with 403 JSON, so it gets the scope or null and
 * redirects. The check itself is the identical one: the memberships come
 * from the database, not from the session, and a requested account is
 * honoured only when the caller holds it.
 */
export async function portalPageScope(
  locals: App.Locals,
  url: URL,
  db: Client,
): Promise<PortalScope | null> {
  const principal = locals.cms;
  if (!principal) return null;
  const access = await portalScope(db, principal.user, url.searchParams.get('accountId'));
  return access.ok ? access.scope : null;
}
