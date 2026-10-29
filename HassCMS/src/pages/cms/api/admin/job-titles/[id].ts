/**
 * GET and PATCH /api/admin/job-titles/{id} on cms.murikah.com.
 *
 * There is no DELETE. Deactivation is `active = 0`, and `user_assignments`
 * holds ON DELETE RESTRICT on `job_title_id`, so a delete would be blocked by
 * the database anyway.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateJobTitle } from '../../../../../lib/cms/admin/userInput.ts';
import {
  listJobTitles,
  getJobTitle,
  createJobTitle,
  updateJobTitle,
} from '../../../../../lib/cms/repos/userAdmin.ts';
import { requireUsersManage } from '../../../../../lib/cms/admin/guard.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'job-titles',
  list: listJobTitles,
  get: getJobTitle,
  validate: validateJobTitle,
  create: createJobTitle,
  update: updateJobTitle,
  read: requireUsersManage,
  write: requireUsersManage,
});
