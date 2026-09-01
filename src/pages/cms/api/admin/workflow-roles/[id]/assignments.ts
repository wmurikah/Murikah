/**
 * GET and POST /api/admin/workflow-roles/{id}/assignments on cms.murikah.com.
 *
 * The scoped assignments that give a person approval authority under this
 * workflow role. Each row carries a scope of BUSINESS_UNIT, AFFILIATE, COUNTRY
 * or GROUP with the matching target, a priority, and an effective window.
 *
 * The workflow role comes from the path, never from the body: an assignment
 * created through this route is an assignment of *this* role, and a payload
 * that named another one would let a caller authorised for one role write
 * against another.
 *
 * GET also returns each assignment's live authority rules, so the screen can
 * warn about an assignment with none. Under the rule this product applies, an
 * assignment with no rule is an approver with no amount, currency or product
 * limit, and an operator who meant to add a limit and did not should see that
 * rather than discover it from an approval.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowRolesManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateAssignment } from '../../../../../../lib/cms/admin/workflowInput.ts';
import {
  createAssignment,
  getWorkflowRole,
  listAssignmentsForRole,
  listRulesForAssignment,
} from '../../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const roleId = context.params.id ?? '';
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const role = await getWorkflowRole(connection.db, roleId);
    if (role === null) return notFound('That workflow role could not be found.');
    const assignments = await listAssignmentsForRole(connection.db, roleId);
    const items = [];
    for (const assignment of assignments) {
      items.push({
        ...assignment,
        rules: await listRulesForAssignment(connection.db, assignment.assignmentId),
      });
    }
    return ok({ role, items });
  } catch (error) {
    return serverError('admin.workflowRoles.assignments', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowRolesManage(context);
  if (!auth.ok) return auth.response;

  const roleId = context.params.id ?? '';
  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateAssignment(await readJson(context.request), roleId, isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const role = await getWorkflowRole(connection.db, roleId);
    if (role === null) return notFound('That workflow role could not be found.');
    const result = await createAssignment(connection.db, parsed.value, ctx);
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.workflowRoles.assign', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
