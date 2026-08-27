/**
 * GET and POST /api/admin/job-titles on cms.murikah.com.
 *
 * A title may be held by any number of people. The seeded data has three
 * Finance Managers, in Kenya, Uganda and Tanzania, and nothing here treats a
 * title as belonging to one person.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateJobTitle } from '../../../../../lib/cms/admin/userInput.ts';
import {
  listJobTitles,
  getJobTitle,
  createJobTitle,
  updateJobTitle,
} from '../../../../../lib/cms/repos/userAdmin.ts';
import { requireUsersManage } from '../../../../../lib/cms/admin/guard.ts';

export const prerender = false;

export const { GET, POST, ALL } = collectionRoute({
  name: 'job-titles',
  list: listJobTitles,
  get: getJobTitle,
  validate: validateJobTitle,
  create: createJobTitle,
  update: updateJobTitle,
  read: requireUsersManage,
  write: requireUsersManage,
});
