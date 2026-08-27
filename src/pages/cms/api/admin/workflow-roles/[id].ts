/**
 * GET and PATCH /api/admin/workflow-roles/{id} on cms.murikah.com.
 *
 * There is no DELETE. Deactivation is `active = 0`, and the history of who held
 * authority under this role stays readable.
 */
import { itemRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  requireWorkflowRolesManage,
  requireWorkflowView,
} from '../../../../../lib/cms/admin/guard.ts';
import { validateWorkflowRole } from '../../../../../lib/cms/admin/workflowInput.ts';
import {
  listWorkflowRoles,
  getWorkflowRole,
  createWorkflowRole,
  updateWorkflowRole,
} from '../../../../../lib/cms/repos/workflowAdmin.ts';

export const prerender = false;

export const { GET, PATCH, ALL } = itemRoute({
  name: 'workflowRoles',
  list: listWorkflowRoles,
  get: getWorkflowRole,
  validate: validateWorkflowRole,
  create: createWorkflowRole,
  update: updateWorkflowRole,
  read: requireWorkflowView,
  write: requireWorkflowRolesManage,
});
