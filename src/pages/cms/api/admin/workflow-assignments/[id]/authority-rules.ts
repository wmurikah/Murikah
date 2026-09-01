/**
 * GET and POST /api/admin/workflow-assignments/{id}/authority-rules.
 *
 * A rule restricts the assignment named in the path by process type, currency,
 * amount band, product group or category, with a priority and its own effective
 * window. Every dimension is optional, and an absent one means no restriction
 * on that dimension rather than a restriction that matches nothing.
 *
 * The assignment comes from the path and never from the body, for the same
 * reason the workflow role does on the assignment route: a caller must not be
 * able to attach a rule to an assignment other than the one they addressed.
 *
 * `process_type` here accepts four values, not the seven `workflow_roles`
 * accepts. A lead, an opportunity and a case cannot carry an authority rule at
 * all, which the validator says in the field message rather than letting the
 * database refuse it with a constraint name.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowRolesManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateAuthorityRule } from '../../../../../../lib/cms/admin/workflowInput.ts';
import {
  createRule,
  getAssignment,
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

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const id = context.params.id ?? '';
    const assignment = await getAssignment(connection.db, id);
    if (assignment === null) return notFound('That assignment could not be found.');
    return ok({ assignment, items: await listRulesForAssignment(connection.db, id) });
  } catch (error) {
    return serverError('admin.authorityRules.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowRolesManage(context);
  if (!auth.ok) return auth.response;

  const assignmentId = context.params.id ?? '';
  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateAuthorityRule(
    await readJson(context.request),
    assignmentId,
    isoDay(ctx.now),
  );
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const assignment = await getAssignment(connection.db, assignmentId);
    if (assignment === null) return notFound('That assignment could not be found.');
    const result = await createRule(connection.db, parsed.value, ctx);
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.authorityRules.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
