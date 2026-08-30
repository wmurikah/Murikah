/**
 * GET and POST /api/admin/business-units on cms.murikah.com.
 *
 * The file is under src/pages/cms/api/, not src/pages/api/: the worker rewrites
 * a cms-host request onto the internal /cms path before Astro routes it, so a
 * file at the repository's api/ root would be the marketing site's endpoint.
 *
 * A shell. The authorisation, the audit context and the response mapping are in
 * @/lib/cms/admin/crudRoute, so no endpoint can be written without them.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateBusinessUnit } from '../../../../../lib/cms/admin/organisationInput.ts';
import {
  listBusinessUnits,
  getBusinessUnit,
  createBusinessUnit,
  updateBusinessUnit,
} from '../../../../../lib/cms/repos/organisationAdmin.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'business-units',
  list: listBusinessUnits,
  get: getBusinessUnit,
  validate: validateBusinessUnit,
  create: createBusinessUnit,
  update: updateBusinessUnit,
});
