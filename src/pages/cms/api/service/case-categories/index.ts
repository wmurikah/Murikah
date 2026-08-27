/**
 * GET and POST /api/service/case-categories on cms.murikah.com.
 *
 * Two levels, category and subcategory, exactly as the table allows. No
 * hard-coded category anywhere; historical cases keep theirs through
 * ON DELETE RESTRICT and deactivation.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  requireCaseCategoriesManage,
  requireCasesView,
} from '../../../../../lib/cms/admin/guard.ts';
import { validateCaseCategory } from '../../../../../lib/cms/admin/serviceInput.ts';
import {
  createCaseCategory,
  getCaseCategory,
  listCaseCategories,
  updateCaseCategory,
} from '../../../../../lib/cms/repos/serviceAdmin.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'caseCategories',
  list: listCaseCategories,
  get: getCaseCategory,
  validate: validateCaseCategory,
  create: createCaseCategory,
  update: updateCaseCategory,
  read: requireCasesView,
  write: requireCaseCategoriesManage,
});
