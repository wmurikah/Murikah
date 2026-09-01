/**
 * GET and POST /api/admin/teams/{id}/members on cms.murikah.com.
 *
 * Not built from the CRUD factory, because membership is not a row that gets
 * edited in place: it is effective-dated, so adding a person is an insert and
 * removing them is an end date on the row that is already there. Pretending it
 * was a fifth master-data table would have made "remove" mean DELETE, which is
 * exactly the loss of history this schema is shaped to prevent.
 *
 * GET returns the current membership. `?history=1` includes rows that have
 * ended, so the default answer to "who is on this team" is the true one.
 */
import type { APIRoute } from 'astro';
import {
  requireOrganisationManage,
  requireOrganisationView,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { isoDate, validateTeamMember } from '../../../../../../lib/cms/admin/organisationInput.ts';
import {
  addTeamMember,
  getTeam,
  listTeamMembers,
} from '../../../../../../lib/cms/repos/organisationAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireOrganisationView(context);
  if (!auth.ok) return auth.response;

  const teamId = context.params.id ?? '';
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;

  try {
    const team = await getTeam(connection.db, teamId);
    if (!team) return notFound('That team could not be found.');

    const history = context.url.searchParams.get('history') === '1';
    const members = await listTeamMembers(connection.db, teamId, history);
    return ok({ team, items: members, includesHistory: history });
  } catch (error) {
    return serverError('admin.teamMembers.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireOrganisationManage(context);
  if (!auth.ok) return auth.response;

  const teamId = context.params.id ?? '';
  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateTeamMember(await readJson(context.request), isoDate(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;

  try {
    const result = await addTeamMember(connection.db, teamId, parsed.value, ctx);
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.teamMembers.add', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
