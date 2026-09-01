/**
 * GET and POST /api/admin/users on cms.murikah.com.
 *
 * The file is under src/pages/cms/api/, not src/pages/api/: the worker rewrites
 * a cms-host request onto the internal /cms path before Astro routes it, so a
 * file at the repository's api/ root would be the marketing site's endpoint.
 *
 * GET filters and paginates in the database. POST creates an INVITED user with
 * a verification token, and returns an invitation link only where the
 * environment permits it.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateCreateUser } from '../../../../../lib/cms/admin/userInput.ts';
import { createUser, listUsers } from '../../../../../lib/cms/repos/userAdmin.ts';
import { issueInvitation, describeDelivery } from '../../../../../lib/cms/admin/invitation.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;

  const q = context.url.searchParams;
  try {
    return ok(
      await listUsers(connection.db, {
        search: q.get('q') ?? undefined,
        status: q.get('status') ?? undefined,
        userType: q.get('userType') ?? undefined,
        countryId: q.get('countryId') ?? undefined,
        affiliateId: q.get('affiliateId') ?? undefined,
        businessUnitId: q.get('businessUnitId') ?? undefined,
        departmentId: q.get('departmentId') ?? undefined,
        jobTitleId: q.get('jobTitleId') ?? undefined,
        teamId: q.get('teamId') ?? undefined,
        page: Number(q.get('page') ?? '1') || 1,
      }),
    );
  } catch (error) {
    return serverError('admin.users.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateCreateUser(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;

  const ctx = writeContext(context.request, auth.principal);
  try {
    // The environment and the secret are read here rather than inside the
    // repository, so the repository stays testable without a worker.
    const { getCmsEnv, invitationLinksVisible } = await import('../../../../../lib/cms/env.ts');
    const env = getCmsEnv();
    const invitation = await issueInvitation(env.sessionSecret, ctx.now);
    const result = await createUser(connection.db, parsed.value, invitation, ctx);
    if (!result.ok) return failure(result);

    // The raw token leaves this process exactly here, exactly once, and only
    // where the environment permits it. It is never logged and never audited.
    return ok(
      {
        user: result.value.user,
        invitation: describeDelivery(result.value.invitationToken, invitationLinksVisible()),
      },
      201,
    );
  } catch (error) {
    return serverError('admin.users.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
