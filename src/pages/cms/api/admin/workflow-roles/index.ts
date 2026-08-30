/**
 * GET and POST /api/admin/workflow-roles on cms.murikah.com.
 *
 * A workflow role is configuration. `SO Finance Approver`, `Case Resolver` and
 * anything an operator adds later are rows, and no name from that table appears
 * in source anywhere in this product: the resolver takes a workflow role id and
 * never a code or a name.
 *
 * Authorisation is ADMIN.WORKFLOW_ROLES.MANAGE, PERM-021 in the seeded
 * catalogue, already granted to ROLE-ADMIN.
 */
import { collectionRoute } from '../../../../../lib/cms/admin/crudRoute.ts';
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

export const { GET, POST, ALL } = collectionRoute({
  name: 'workflowRoles',
  list: listWorkflowRoles,
  get: getWorkflowRole,
  validate: validateWorkflowRole,
  create: createWorkflowRole,
  update: updateWorkflowRole,
  read: requireWorkflowView,
  write: requireWorkflowRolesManage,
});
