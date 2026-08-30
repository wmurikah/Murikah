/**
 * GET and POST /api/admin/roles on cms.murikah.com.
 *
 * Creating a role is configuration, not a deployment. A Credit Manager, a
 * Regional Customer Service Lead or a Data Uploader is a name and a bag of
 * permission codes, and nothing in this product reads a role's name to decide
 * anything.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireRolesManage } from '../../../../../lib/cms/admin/guard.ts';
import { validateRole } from '../../../../../lib/cms/admin/rbacInput.ts';
import {
  listRoles,
  getRole,
  createRole,
  updateRole,
} from '../../../../../lib/cms/repos/rbacAdmin.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'roles',
  list: listRoles,
  get: getRole,
  validate: validateRole,
  create: createRole,
  update: updateRole,
  read: requireRolesManage,
  write: requireRolesManage,
});
