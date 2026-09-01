/**
 * GET and POST /api/admin/users/{id}/roles on cms.murikah.com.
 *
 * Build Prompt 06 made this tab read-only. This phase makes it writable, which
 * re-arms the section 13 protection that phase relied on being unnecessary:
 * with a write path now open, the payload is the attack surface.
 *
 * So: the person being assigned to comes from the path, the person doing the
 * assigning comes from the session, and neither is read from the body. A
 * `user_id` in the JSON is inert. A `role_id` is read, because choosing a role
 * is the point, and it is checked against `access_roles` rather than trusted.
 */
import type { APIRoute } from 'astro';
import { requireRolesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { isoDay } from '../../../../../../lib/cms/admin/userInput.ts';
import { validateUserRole } from '../../../../../../lib/cms/admin/rbacInput.ts';
import {
  assignUserRole,
  listUserRoleAssignments,
} from '../../../../../../lib/cms/repos/rbacAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ items: await listUserRoleAssignments(connection.db, context.params.id ?? '') });
  } catch (error) {
    return serverError('admin.userRoles.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateUserRole(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    // The path, never the body. A caller who wants to grant somebody else a
    // role has to say so in the URL, where the guard has already seen it.
    const result = await assignUserRole(connection.db, context.params.id ?? '', parsed.value, ctx);
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.userRoles.assign', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
