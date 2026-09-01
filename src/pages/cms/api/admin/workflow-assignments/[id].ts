/**
 * GET and PATCH /api/admin/workflow-assignments/{id} on cms.murikah.com.
 *
 * PATCH supersedes an assignment: it sets `effective_to` and `active` and
 * touches nothing else. The person, the role, the scope and the start date are
 * the historical record of who held authority and when, and a delegation that
 * rewrote them would make the audit trail describe a past that did not happen.
 *
 * A new holder, or the same holder on new terms, is a new row through
 * /api/admin/workflow-roles/{id}/assignments. That is also section 16's
 * delegation mechanism: an acting approver is an effective-dated assignment
 * beside the substantive one, not an edit to it.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowRolesManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateSupersede } from '../../../../../lib/cms/admin/workflowInput.ts';
import {
  getAssignment,
  listRulesForAssignment,
  supersedeAssignment,
} from '../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const id = context.params.id ?? '';
    const assignment = await getAssignment(connection.db, id);
    if (assignment === null) return notFound('That assignment could not be found.');
    return ok({ ...assignment, rules: await listRulesForAssignment(connection.db, id) });
  } catch (error) {
    return serverError('admin.workflowAssignments.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireWorkflowRolesManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateSupersede(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await supersedeAssignment(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.workflowAssignments.supersede', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
