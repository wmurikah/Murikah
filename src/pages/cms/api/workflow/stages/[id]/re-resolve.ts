/**
 * POST /api/workflow/stages/{id}/re-resolve on cms.murikah.com.
 *
 * The deliberate, audited re-resolution of a started stage.
 *
 * This exists because configuration changes, and a stage that started before a
 * correction may be waiting on somebody who should no longer be its approver.
 * It is the only path that replaces a started stage's assignees, and it is
 * never called on a read: loading a stage returns what was persisted.
 *
 * An assignee who has already acted keeps their row and their decision. A
 * recorded decision is a fact about what somebody did, and dropping it because
 * the configuration moved would erase evidence.
 *
 * Authorisation is ADMIN.WORKFLOW_ROLES.MANAGE, not the weaker workflow view:
 * re-resolving a stage against changed configuration reaches the same outcome
 * as editing the assignment directly, so it needs the same permission.
 *
 * The transaction context is restated in the body because the schema has
 * nowhere to hold it: `workflow_instances` carries an entity type and an entity
 * id and no amount, currency or product. Adding a column would be a schema
 * change. What was used is recorded in the audit row's after state.
 */
import type { APIRoute } from 'astro';
import { requireWorkflowRolesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validatePreview } from '../../../../../../lib/cms/admin/workflowInput.ts';
import { reResolveStage } from '../../../../../../lib/cms/workflow/runtime.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { apiError, notFound } from '../../../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowRolesManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validatePreview(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await reResolveStage(
      connection.db,
      context.params.id ?? '',
      parsed.value.context,
      ctx,
    );
    if (result.ok) return ok({ assignees: result.assignees });

    switch (result.kind) {
      case 'not_found':
        return notFound('That stage could not be found.');
      case 'stage_concluded':
        return apiError('conflict', 'That stage has already concluded.', 409);
      case 'exception':
        return apiError(
          'conflict',
          'That configuration still has no eligible approver, so the stage was left as it was.',
          409,
        );
    }
  } catch (error) {
    return serverError('workflow.stages.reResolve', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
