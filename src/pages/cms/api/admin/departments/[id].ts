/**
 * GET and PATCH /api/admin/departments/{id} on cms.murikah.com.
 *
 * Astro's file convention is [id], never :id. There is no DELETE: deactivation
 * is a PATCH setting active to false, and the row stays.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateDepartment } from '../../../../../lib/cms/admin/organisationInput.ts';
import {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
} from '../../../../../lib/cms/repos/organisationAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'departments',
  list: listDepartments,
  get: getDepartment,
  validate: validateDepartment,
  create: createDepartment,
  update: updateDepartment,
});
