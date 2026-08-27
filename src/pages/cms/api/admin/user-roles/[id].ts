/**
 * PATCH /api/admin/user-roles/{id} on cms.murikah.com.
 *
 * Ends or reactivates a role assignment and replaces its scopes. The
 * last-administrator guard runs in the repository before anything is written,
 * so removing the last live grant of ADMIN.ROLES.MANAGE is refused by the
 * endpoint rather than by the form.
 */
import type { APIRoute } from 'astro';
import { requireRolesManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateUserRoleUpdate } from '../../../../../lib/cms/admin/rbacInput.ts';
import { updateUserRole } from '../../../../../lib/cms/repos/rbacAdmin.ts';
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
  const auth = requireRolesManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateUserRoleUpdate(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updateUserRole(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.userRoles.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
