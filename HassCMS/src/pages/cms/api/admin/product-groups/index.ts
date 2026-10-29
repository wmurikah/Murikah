/**
 * GET and POST /api/admin/product-groups on cms.murikah.com.
 *
 * `PETROLEUM`, `AVIATION`, `LPG`, `LUBRICANTS` and `OTHER` are seeded rows, not
 * a fixed list, and none of them appears in source anywhere in this product.
 * An administrator creates a new group here and it appears in the tree, in the
 * cascading selectors and in the authority rule form with no code change.
 *
 * Authorisation is ADMIN.PRODUCT_CATALOG.MANAGE, PERM-028 in the seeded
 * catalogue, already granted to ROLE-ADMIN.
 *
 * There is no DELETE. `product_categories.product_group_id` is ON DELETE
 * RESTRICT, so a group holding categories cannot be removed, and deactivation
 * is the operation that exists instead.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireCatalogueManage } from '../../../../../lib/cms/admin/guard.ts';
import { validateGroup } from '../../../../../lib/cms/admin/catalogueInput.ts';
import {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
} from '../../../../../lib/cms/repos/catalogueAdmin.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'productGroups',
  list: listGroups,
  get: getGroup,
  validate: validateGroup,
  create: createGroup,
  update: updateGroup,
  read: requireCatalogueManage,
  write: requireCatalogueManage,
});
