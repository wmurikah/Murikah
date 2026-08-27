/**
 * GET and POST /api/crm/lead-sources on cms.murikah.com.
 *
 * The seeded sources are rows, not a list in source: nothing in this product
 * names "Website Enquiry" or "Customer Service Referral". An administrator adds
 * one here and it appears in every lead form with no code change.
 *
 * There is no DELETE. `leads.lead_source_id` is ON DELETE RESTRICT, so a source
 * with history cannot be removed, and `active = 0` is what takes it out of new
 * selection while every historical lead keeps pointing at it.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireLeadSourcesManage, requireLeadsView } from '../../../../../lib/cms/admin/guard.ts';
import { validateLeadSource } from '../../../../../lib/cms/admin/leadInput.ts';
import {
  createLeadSource,
  getLeadSource,
  listLeadSources,
  updateLeadSource,
} from '../../../../../lib/cms/repos/leadAdmin.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'leadSources',
  list: listLeadSources,
  get: getLeadSource,
  validate: validateLeadSource,
  create: createLeadSource,
  update: updateLeadSource,
  // Anybody who may read a lead may read the source list: a lead form needs it.
  read: requireLeadsView,
  write: requireLeadSourcesManage,
});
