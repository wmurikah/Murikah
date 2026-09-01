/**
 * POST /api/admin/workflows/{id}/versions on cms.murikah.com.
 *
 * A new version of the definition named in the path, with its stages copied
 * forward, taking the next unused `version_no` for that workflow name.
 *
 * Existing `workflow_instances` keep pointing at the row they were created
 * under, so a record created under version 1 still reports version 1 for ever.
 * That is not a convention this endpoint maintains by being careful: the
 * foreign key is ON DELETE RESTRICT and nothing here touches the instances at
 * all, so the old version cannot be removed and cannot be repointed.
 *
 * `retirePrevious` closes the old version on the new one's effective date, so
 * new transactions pick up version 2 and started ones are untouched.
 */
import type { APIRoute } from 'astro';
import { requireWorkflowsManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateNewVersion } from '../../../../../../lib/cms/admin/workflowInput.ts';
import { listStages, newVersion } from '../../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { isoDay } from '../../../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateNewVersion(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await newVersion(connection.db, context.params.id ?? '', parsed.value, ctx);
    if (!result.ok) return failure(result);
    return ok(
      {
        definition: result.value,
        stages: await listStages(connection.db, result.value.workflowDefinitionId),
      },
      201,
    );
  } catch (error) {
    return serverError('admin.workflows.newVersion', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
