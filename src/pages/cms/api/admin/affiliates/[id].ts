/**
 * GET and PATCH /api/admin/affiliates/{id} on cms.murikah.com.
 *
 * Astro's file convention is [id], never :id. There is no DELETE: deactivation
 * is a PATCH setting active to false, and the row stays.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateAffiliate } from '../../../../../lib/cms/admin/organisationInput.ts';
import {
  listAffiliates,
  getAffiliate,
  createAffiliate,
  updateAffiliate,
} from '../../../../../lib/cms/repos/organisationAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'affiliates',
  list: listAffiliates,
  get: getAffiliate,
  validate: validateAffiliate,
  create: createAffiliate,
  update: updateAffiliate,
});
