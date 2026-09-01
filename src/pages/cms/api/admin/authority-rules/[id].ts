/**
 * GET and PATCH /api/admin/authority-rules/{id} on cms.murikah.com.
 *
 * There is no DELETE. A rule that no longer applies is closed with
 * `effective_to`, or deactivated, and the record of what authority existed when
 * a past approval was made stays readable. An approval that happened under a
 * threshold nobody can look up afterwards is not auditable.
 *
 * The assignment a rule belongs to is not in the update: a rule cannot be moved
 * from one person's authority to another's, because that would silently change
 * who could have approved what, historically as well as in future.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowRolesManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateAuthorityRule } from '../../../../../lib/cms/admin/workflowInput.ts';
import { getRule, updateRule } from '../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const rule = await getRule(connection.db, context.params.id ?? '');
    return rule === null ? notFound('That rule could not be found.') : ok(rule);
  } catch (error) {
    return serverError('admin.authorityRules.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireWorkflowRolesManage(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const ctx = writeContext(context.request, auth.principal);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const existing = await getRule(connection.db, id);
    if (existing === null) return notFound('That rule could not be found.');

    // The assignment id comes from the stored row, not from the payload.
    const parsed = validateAuthorityRule(
      await readJson(context.request),
      existing.assignmentId,
      isoDay(ctx.now),
    );
    if (!parsed.ok) return invalid(parsed.errors);

    const result = await updateRule(connection.db, id, parsed.value, ctx);
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.authorityRules.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
