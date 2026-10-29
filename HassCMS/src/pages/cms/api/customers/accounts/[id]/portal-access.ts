/**
 * GET and POST /api/customers/accounts/{id}/portal-access on
 * cms.murikah.com. The internal side of portal membership.
 *
 * GET lists the account's memberships and the contacts that could be
 * invited. POST does one of four things, named by `action`: invite, resend,
 * suspend, revoke, reinstate.
 *
 * THE ACCOUNT IS RESOLVED THROUGH THE SCOPE RESOLVER FIRST. `getAccount`
 * applies the Build Prompt 07 scope and returns null for an account the
 * caller may not see, so an administrator in one affiliate cannot invite a
 * portal user onto another affiliate's customer by posting its identifier.
 * The permission check alone would not have stopped that: holding
 * ACCOUNTS.MANAGE says what you may do, never to whom.
 *
 * There is no DELETE. Revoking is a status, the user row stays, and the
 * audit trail keeps its subject.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import {
  requirePortalAccessView,
  requirePortalAccessManage,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { getAccount } from '../../../../../../lib/cms/repos/accountAdmin.ts';
import {
  listMemberships,
  invitableContacts,
  portalRoles,
} from '../../../../../../lib/cms/repos/portalAdmin.ts';
import {
  invitePortalUser,
  setMembershipStatus,
} from '../../../../../../lib/cms/repos/portalWrites.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

const ACTIONS = ['invite', 'resend', 'suspend', 'revoke', 'reinstate'] as const;
type Action = (typeof ACTIONS)[number];

export const GET: APIRoute = async (context) => {
  const auth = requirePortalAccessView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const accountId = context.params.id ?? '';
  try {
    const account = await getAccount(connection.db, auth.principal.user.userId, accountId);
    if (account === null) return notFound('That account could not be found.');
    const [memberships, contacts, roles] = await Promise.all([
      listMemberships(connection.db, accountId),
      invitableContacts(connection.db, accountId),
      portalRoles(connection.db),
    ]);
    return ok({ memberships, contacts, roles });
  } catch (error) {
    return serverError('customers.portalAccess.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requirePortalAccessManage(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const accountId = context.params.id ?? '';
  const body = ((await readJson(context.request)) ?? {}) as Record<string, unknown>;
  const raw = String(body.action ?? '');
  if (!(ACTIONS as readonly string[]).includes(raw)) {
    return invalid([{ field: 'action', message: 'That is not something this can do.' }]);
  }
  const action = raw as Action;
  const ctx = writeContext(context.request, auth.principal);

  try {
    const account = await getAccount(connection.db, ctx.actorUserId, accountId);
    if (account === null) return notFound('That account could not be found.');

    // Invite and resend are the same write. The membership upsert re-stamps
    // `invited_at` and writes a fresh PORTAL_USER_INVITED audit, which is
    // exactly what resending an invitation means. A separate code path would
    // have been a second way to reach the same three statements.
    if (action === 'invite' || action === 'resend') {
      const result = await invitePortalUser(
        connection.db,
        ctx.actorUserId,
        {
          contactId: String(body.contactId ?? ''),
          accountId,
          portalRoleId: String(body.portalRoleId ?? ''),
        },
        ctx.now,
        ctx.ip,
        ctx.userAgent,
      );
      return result.ok
        ? ok({ membershipId: result.membershipId, userId: result.userId }, 201)
        : invalid([{ field: result.field ?? 'contactId', message: result.reason }]);
    }

    const membershipId = String(body.membershipId ?? '');
    // The membership must belong to the account named in the path. Without
    // this, a valid identifier from another customer would be accepted by a
    // caller who legitimately holds this one.
    const memberships = await listMemberships(connection.db, accountId);
    if (!memberships.some((row) => row.membershipId === membershipId)) {
      return notFound('That portal access could not be found.');
    }
    const status = action === 'suspend' ? 'SUSPENDED' : action === 'revoke' ? 'REVOKED' : 'ACTIVE';
    const result = await setMembershipStatus(
      connection.db,
      ctx.actorUserId,
      membershipId,
      status,
      ctx.now,
      ctx.ip,
      ctx.userAgent,
    );
    return result.ok
      ? ok({ membershipId: result.membershipId })
      : invalid([{ field: result.field ?? 'membershipId', message: result.reason }]);
  } catch (error) {
    return serverError('customers.portalAccess.write', error);
  }
};

export const ALL: APIRoute = (): Response => methodNotAllowed('GET or POST');
