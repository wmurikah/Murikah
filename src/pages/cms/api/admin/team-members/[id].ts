/**
 * PATCH /api/admin/team-members/{id} on cms.murikah.com.
 *
 * The one thing this does is end a membership: stamp `effective_to` and set
 * `active = 0`. The row stays where it is, so "who was on this team in March"
 * has an answer next year.
 *
 * There is no DELETE here and no code path in this phase that removes a
 * `team_members` row.
 */
import type { APIRoute } from 'astro';
import { requireOrganisationManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { isoDate, validateTeamMemberEnd } from '../../../../../lib/cms/admin/organisationInput.ts';
import { endTeamMembership } from '../../../../../lib/cms/repos/organisationAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  const auth = requireOrganisationManage(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateTeamMemberEnd(await readJson(context.request), isoDate(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;

  try {
    const result = await endTeamMembership(connection.db, id, parsed.value.effectiveTo, ctx);
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.teamMembers.end', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
