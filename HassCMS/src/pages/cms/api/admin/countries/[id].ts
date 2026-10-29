/**
 * GET and PATCH /api/admin/countries/{id} on cms.murikah.com.
 *
 * Astro's file convention is [id], never :id. There is no DELETE: deactivation
 * is a PATCH setting active to false, and the row stays.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateCountry } from '../../../../../lib/cms/admin/organisationInput.ts';
import {
  listCountries,
  getCountry,
  createCountry,
  updateCountry,
} from '../../../../../lib/cms/repos/organisationAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'countries',
  list: listCountries,
  get: getCountry,
  validate: validateCountry,
  create: createCountry,
  update: updateCountry,
});
