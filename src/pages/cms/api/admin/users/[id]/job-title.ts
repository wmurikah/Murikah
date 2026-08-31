/**
 * PUT /api/admin/users/{id}/job-title on cms.murikah.com.
 *
 * The user Edit screen offers a job title dropdown, which is a convenience
 * over the assignment lifecycle rather than a second place titles live. This
 * endpoint ends the person's current primary assignment and inserts a
 * superseding one carrying the new title at the same department, level and
 * location. `user_assignments` stays authoritative and no historical row is
 * rewritten; the reasoning is in `changePrimaryJobTitle`.
 *
 * ADMIN.USERS.MANAGE, not ADMIN.ROLES.MANAGE. A job title is organisational
 * position and grants nothing: no permission, no scope and no approval
 * authority follows from it anywhere in this product. So the person who
 * administers people may set it, and doing so widens nobody's access.
 *
 * The subject comes from the path and the actor from the session. A `userId`
 * in the body is inert.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateJobTitleChange } from '../../../../../../lib/cms/admin/jobTitleMappingInput.ts';
import { changePrimaryJobTitle } from '../../../../../../lib/cms/repos/userAdmin.ts';
import { mappingsForTitle } from '../../../../../../lib/cms/repos/jobTitleMappings.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PUT: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateJobTitleChange(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await changePrimaryJobTitle(
      connection.db,
      context.params.id ?? '',
      parsed.value.jobTitleId,
      writeContext(context.request, auth.principal),
    );
    if (!result.ok) return failure(result);
    // The defaults the new title suggests, returned WITH the change rather than
    // applied by it. The screen shows them and an administrator decides; this
    // response grants nothing.
    const suggested = await mappingsForTitle(connection.db, parsed.value.jobTitleId);
    return ok({ assignment: result.value, suggested });
  } catch (error) {
    return serverError('admin.users.jobTitle', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PUT');
