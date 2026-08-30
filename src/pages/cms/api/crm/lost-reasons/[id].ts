/**
 * GET and PATCH /api/crm/lost-reasons/{id} on cms.murikah.com.
 *
 * Rename or deactivate. Never remove: see the note on the collection route.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  requireLostReasonsManage,
  requireOpportunitiesView,
} from '../../../../../lib/cms/admin/guard.ts';
import { validateLostReason } from '../../../../../lib/cms/admin/opportunityInput.ts';
import {
  createLostReason,
  getLostReason,
  listLostReasons,
  updateLostReason,
} from '../../../../../lib/cms/repos/opportunityAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'lostReasons',
  list: listLostReasons,
  get: getLostReason,
  validate: validateLostReason,
  create: createLostReason,
  update: updateLostReason,
  read: requireOpportunitiesView,
  write: requireLostReasonsManage,
});
