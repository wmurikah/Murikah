/**
 * GET and PATCH /api/admin/roles/{id} on cms.murikah.com.
 *
 * No DELETE. `user_roles.role_id` is ON DELETE RESTRICT, so an assigned role
 * cannot be deleted anyway; deactivation is `active = 0`.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireRolesManage } from '../../../../../lib/cms/admin/guard.ts';
import { validateRole } from '../../../../../lib/cms/admin/rbacInput.ts';
import {
  listRoles,
  getRole,
  createRole,
  updateRole,
} from '../../../../../lib/cms/repos/rbacAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'roles',
  list: listRoles,
  get: getRole,
  validate: validateRole,
  create: createRole,
  update: updateRole,
  read: requireRolesManage,
  write: requireRolesManage,
});
