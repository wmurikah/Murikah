/**
 * GET and PATCH /api/admin/product-groups/{id} on cms.murikah.com.
 *
 * PATCH is an UPDATE against this primary key, and never a delete and reinsert.
 * `approval_authority_rules.product_group_id` points here with ON DELETE SET
 * NULL, so recreating the row on a rename would silently strip the product
 * restriction from every authority rule that named this group and widen
 * somebody's approval limit, leaving the audit trail recording only a rename.
 *
 * `group_code` is not updatable for a related reason: a code is what an
 * operator quotes in an import file or a spreadsheet, and repointing it breaks
 * references nothing in this product can see.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireCatalogueManage } from '../../../../../lib/cms/admin/guard.ts';
import { validateGroup } from '../../../../../lib/cms/admin/catalogueInput.ts';
import {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
} from '../../../../../lib/cms/repos/catalogueAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'productGroups',
  list: listGroups,
  get: getGroup,
  validate: validateGroup,
  create: createGroup,
  update: updateGroup,
  read: requireCatalogueManage,
  write: requireCatalogueManage,
});
