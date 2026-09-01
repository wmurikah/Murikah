/**
 * GET and PATCH /api/admin/roles/{id}/permissions on cms.murikah.com.
 *
 * GET returns the matrix for this role, grouped module then resource then
 * action, entirely from the `permissions` table. PATCH replaces the role's
 * grants with the submitted set.
 *
 * The last-administrator guard lives in the repository and runs before the
 * write, in its after-state form. Revoking ADMIN.ROLES.MANAGE from the last
 * role that carries it is refused here, at the only route to the table, rather
 * than by a confirmation dialogue a caller can skip.
 */
import type { APIRoute } from 'astro';
import { requireRolesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validatePermissionChanges } from '../../../../../../lib/cms/admin/rbacInput.ts';
import {
  getRole,
  permissionMatrix,
  setRolePermissions,
} from '../../../../../../lib/cms/repos/rbacAdmin.ts';
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
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const roleId = context.params.id ?? '';
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const role = await getRole(connection.db, roleId);
    if (!role) return notFound('That role could not be found.');
    return ok({ role, modules: await permissionMatrix(connection.db, roleId) });
  } catch (error) {
    return serverError('admin.roles.matrix', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validatePermissionChanges(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await setRolePermissions(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.roles.setPermissions', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
