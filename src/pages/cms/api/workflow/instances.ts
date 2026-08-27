/**
 * POST /api/workflow/instances on cms.murikah.com.
 *
 * Starts a workflow for a record: creates the instance, creates its first stage
 * instance, resolves the approvers once and persists them.
 *
 * The definition is chosen by applicability when the caller does not name one,
 * which is what the live path will do when Build Prompt 10 imports sales
 * orders. Once the instance holds a `workflow_definition_id`, that version is
 * what the record went through for ever.
 *
 * When nobody is eligible the stage is still created, in PENDING, with no
 * assignees, an `APPROVAL_EXCEPTION` audit row and a 409 saying so. It does not
 * assign a random user and it does not default to the system administrator: the
 * stage stays visible and unresolved until the configuration is corrected.
 */
import type { APIRoute } from 'astro';
import { requireWorkflowsManage, writeContext } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { validateStartWorkflow } from '../../../../lib/cms/admin/workflowInput.ts';
import { getDefinition, pickDefinition } from '../../../../lib/cms/repos/workflowAdmin.ts';
import { startWorkflow } from '../../../../lib/cms/workflow/runtime.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../lib/cms/admin/respond.ts';
import { apiError, notFound } from '../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateStartWorkflow(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);
  const input = parsed.value;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const definition =
      input.workflowDefinitionId === null
        ? await pickDefinition(connection.db, {
            processType: input.context.processType,
            countryId: input.context.countryId,
            affiliateId: input.context.affiliateId,
            businessUnitId: input.context.businessUnitId,
            onDate: input.context.eventDate,
          })
        : await getDefinition(connection.db, input.workflowDefinitionId);
    if (definition === null) {
      return notFound('No workflow applies to that process and organisation on that date.');
    }

    const started = await startWorkflow(
      connection.db,
      {
        workflowDefinitionId: definition.workflowDefinitionId,
        entityType: input.entityType,
        entityId: input.entityId,
        context: input.context,
      },
      ctx,
    );
    if (started === null) return notFound('That workflow has no stages.');

    if (!started.first.ok) {
      if (started.first.kind === 'not_found') return notFound('That stage could not be found.');
      // The instance and the stage exist and are visible; nobody could be
      // assigned. 409 rather than 500: nothing failed, the configuration does
      // not cover this transaction, and an administrator has to widen it.
      return apiError(
        'conflict',
        'That stage has no eligible approver. It is waiting on configuration.',
        409,
      );
    }

    return ok(
      {
        workflowInstanceId: started.workflowInstanceId,
        definition,
        stageInstanceId: started.first.stageInstanceId,
        assignees: started.first.assignees,
        threshold: started.first.threshold,
      },
      201,
    );
  } catch (error) {
    return serverError('workflow.instances.start', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
