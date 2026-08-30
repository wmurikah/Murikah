/**
 * GET and PATCH /api/crm/lead-sources/{id} on cms.murikah.com.
 *
 * Rename or deactivate. Never remove: see the note on the collection route.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireLeadSourcesManage, requireLeadsView } from '../../../../../lib/cms/admin/guard.ts';
import { validateLeadSource } from '../../../../../lib/cms/admin/leadInput.ts';
import {
  createLeadSource,
  getLeadSource,
  listLeadSources,
  updateLeadSource,
} from '../../../../../lib/cms/repos/leadAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'leadSources',
  list: listLeadSources,
  get: getLeadSource,
  validate: validateLeadSource,
  create: createLeadSource,
  update: updateLeadSource,
  read: requireLeadsView,
  write: requireLeadSourcesManage,
});
