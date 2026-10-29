/**
 * GET and POST /api/crm/lost-reasons on cms.murikah.com.
 *
 * The configured vocabulary for why deals are lost. No hard-coded reasons
 * anywhere in the product, no free text on a lost move: `moveStage` refuses a
 * loss without one of these rows, so this list is the analysis dimension.
 *
 * There is no DELETE. A reason carried by historical losses deactivates, and
 * every past loss keeps pointing at it.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
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

export const { GET, POST, ALL } = collectionRoute({
  name: 'lostReasons',
  list: listLostReasons,
  get: getLostReason,
  validate: validateLostReason,
  create: createLostReason,
  update: updateLostReason,
  // The lost modal on the opportunity page needs the list to offer it.
  read: requireOpportunitiesView,
  write: requireLostReasonsManage,
});
