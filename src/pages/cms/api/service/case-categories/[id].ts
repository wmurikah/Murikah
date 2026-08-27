/**
 * GET and PATCH /api/service/case-categories/{id} on cms.murikah.com.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
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

export const { GET, PATCH, ALL } = itemRoute({
  name: 'caseCategories',
  list: listCaseCategories,
  get: getCaseCategory,
  validate: validateCaseCategory,
  create: createCaseCategory,
  update: updateCaseCategory,
  read: requireCasesView,
  write: requireCaseCategoriesManage,
});
