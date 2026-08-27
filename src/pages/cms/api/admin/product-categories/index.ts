/**
 * GET and POST /api/admin/product-categories on cms.murikah.com.
 *
 * `category_code` is UNIQUE across the whole table, not per group, so two
 * groups cannot both hold a category coded PREMIUM. The refusal says so in the
 * field message rather than returning a constraint name an administrator who
 * has just checked their own group cannot interpret.
 *
 * `category_name` carries no uniqueness constraint and none is invented: two
 * groups may both hold a category named Diesel, and the code is the identifier.
 *
 * The three rules the schema does not enforce are enforced in the repository,
 * where the rows they depend on can be read: a child sits in its parent's
 * group, the parent chain does not close into a cycle, and the tree does not go
 * deeper than the interface can render.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireCatalogueManage } from '../../../../../lib/cms/admin/guard.ts';
import { validateCategory } from '../../../../../lib/cms/admin/catalogueInput.ts';
import {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
} from '../../../../../lib/cms/repos/catalogueAdmin.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'productCategories',
  list: listCategories,
  get: getCategory,
  validate: validateCategory,
  create: createCategory,
  update: updateCategory,
  read: requireCatalogueManage,
  write: requireCatalogueManage,
});
