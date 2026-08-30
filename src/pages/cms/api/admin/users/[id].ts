/**
 * GET and PATCH /api/admin/users/{id} on cms.murikah.com.
 *
 * Astro's file convention is [id], never :id. There is no DELETE: a user is
 * suspended, never removed. `user_assignments`, `team_members`, `login_attempts`
 * and `audit_events` all reference users and several are ON DELETE RESTRICT, so
 * a delete would either be blocked or would destroy the accountability record.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateUpdateUser } from '../../../../../lib/cms/admin/userInput.ts';
import {
  getSecurity,
  getUser,
  listAssignments,
  listSourceIdentities,
  listUserRoles,
  listUserTeams,
  listWorkflowAuthority,
  updateUser,
} from '../../../../../lib/cms/repos/userAdmin.ts';
import { userActivity } from '../../../../../lib/cms/repos/auditTrail.ts';
import { issueInvitation, describeDelivery } from '../../../../../lib/cms/admin/invitation.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const connection = await connect();
  if ('response' in connection) return connection.response;

  try {
    const user = await getUser(connection.db, id);
    if (!user) return notFound('That user could not be found.');
    const [assignments, teams, roles, authority, identities, security, audit] = await Promise.all([
      listAssignments(connection.db, id),
      listUserTeams(connection.db, id),
      listUserRoles(connection.db, id),
      listWorkflowAuthority(connection.db, id),
      listSourceIdentities(connection.db, id),
      getSecurity(connection.db, id),
      // A DEFECT FOUND AND CLOSED IN PHASE 26. This previously called
      // `listUserAudit`, which selected every event whose entity_id was this
      // user, applied no audit scope and no permission check, and returned
      // `before_json` and `after_json` raw. A historical row containing a
      // password hash would have been served verbatim to anybody holding
      // ADMIN.USERS.MANAGE. It now reads through the audit repository, which
      // applies the caller's own audit scope, excludes authentication events,
      // and masks every credential field.
      userActivity(connection.db, auth.principal.user.userId, id),
    ]);
    // Roles and workflow authority are read-only in this phase; the flags say
    // so in the payload as well as on screen, so a client cannot mistake the
    // absence of a write endpoint for one it has not found yet.
    return ok({
      user,
      assignments,
      teams,
      roles,
      rolesEditable: false,
      workflowAuthority: authority,
      workflowAuthorityEditable: false,
      sourceIdentities: identities,
      security,
      audit,
    });
  } catch (error) {
    return serverError('admin.users.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const parsed = validateUpdateUser(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;

  const ctx = writeContext(context.request, auth.principal);
  try {
    const { getCmsEnv, invitationLinksVisible } = await import('../../../../../lib/cms/env.ts');
    const env = getCmsEnv();
    // Issued unconditionally and used only when the email actually changed, so
    // the whole update stays one batch rather than branching mid-write.
    const invitation = await issueInvitation(env.sessionSecret, ctx.now);
    const result = await updateUser(connection.db, id, parsed.value, invitation, ctx);
    if (!result.ok) return failure(result);

    return ok({
      user: result.value.user,
      emailChanged: result.value.emailChanged,
      invitation:
        result.value.invitationToken === null
          ? null
          : describeDelivery(result.value.invitationToken, invitationLinksVisible()),
    });
  } catch (error) {
    return serverError('admin.users.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
