/**
 * GET and PATCH /api/admin/teams/{id} on cms.murikah.com.
 *
 * Astro's file convention is [id], never :id. There is no DELETE: deactivation
 * is a PATCH setting active to false, and the row stays.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateTeam } from '../../../../../lib/cms/admin/organisationInput.ts';
import {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
} from '../../../../../lib/cms/repos/organisationAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'teams',
  list: listTeams,
  get: getTeam,
  validate: validateTeam,
  create: createTeam,
  update: updateTeam,
});
