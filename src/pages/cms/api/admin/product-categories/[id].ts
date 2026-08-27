/**
 * GET and PATCH /api/admin/product-categories/{id} on cms.murikah.com.
 *
 * Moving a category to a new parent runs the same cycle walk as creating one,
 * with the category being moved passed in: a cycle exists exactly when the
 * proposed parent's ancestor chain already contains it. The one-step case, a
 * category set as its own parent, is refused first, because the chain walk
 * would otherwise start from the row being changed.
 *
 * As on the group route, this is an UPDATE against the existing primary key.
 * `approval_authority_rules.product_category_id` must still reference this
 * category after a rename.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireCatalogueManage } from '../../../../../lib/cms/admin/guard.ts';
import { validateCategory } from '../../../../../lib/cms/admin/catalogueInput.ts';
import {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
} from '../../../../../lib/cms/repos/catalogueAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'productCategories',
  list: listCategories,
  get: getCategory,
  validate: validateCategory,
  create: createCategory,
  update: updateCategory,
  read: requireCatalogueManage,
  write: requireCatalogueManage,
});
