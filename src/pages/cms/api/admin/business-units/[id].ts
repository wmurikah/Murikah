/**
 * GET and PATCH /api/admin/business-units/{id} on cms.murikah.com.
 *
 * Astro's file convention is [id], never :id. There is no DELETE: deactivation
 * is a PATCH setting active to false, and the row stays.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateBusinessUnit } from '../../../../../lib/cms/admin/organisationInput.ts';
import {
  listBusinessUnits,
  getBusinessUnit,
  createBusinessUnit,
  updateBusinessUnit,
} from '../../../../../lib/cms/repos/organisationAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'business-units',
  list: listBusinessUnits,
  get: getBusinessUnit,
  validate: validateBusinessUnit,
  create: createBusinessUnit,
  update: updateBusinessUnit,
});
