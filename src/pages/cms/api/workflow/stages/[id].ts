/**
 * GET /api/workflow/stages/{id} on cms.murikah.com.
 *
 * The stage instance and its assignees, read from `workflow_stage_assignees`.
 *
 * IT DOES NOT RE-RESOLVE. The resolver is not called here at all. A stage that
 * resolved yesterday shows the same people today, whatever changed in
 * configuration in between, because the answer was persisted when the stage was
 * created and this reads it. Re-resolution is a deliberate administrative
 * action with its own route and its own audit row.
 *
 * The one-sentence reason each assignee carries is shown. The full resolution
 * trace is not: it belongs on the administrative preview, behind a workflow
 * permission, not in the hands of every approver who opens a stage.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  approvalThreshold,
  getStageConfig,
  getStageInstance,
  instanceVersion,
  listAssignees,
} from '../../../../../lib/cms/workflow/runtime.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const instance = await getStageInstance(connection.db, id);
    if (instance === null) return notFound('That stage could not be found.');
    const stage = await getStageConfig(connection.db, instance.workflowStageId);
    if (stage === null) return notFound('That stage could not be found.');

    const assignees = await listAssignees(connection.db, id);
    const version = await instanceVersion(connection.db, instance.workflowInstanceId);
    const you = auth.principal.user.userId;

    return ok({
      stageInstance: instance,
      stage: {
        stageCode: stage.stageCode,
        stageName: stage.stageName,
        sequenceNo: stage.sequenceNo,
        approvalMode: stage.approvalMode,
        requiredApprovals: stage.requiredApprovals,
        terminalStage: stage.terminalStage,
      },
      version,
      threshold: approvalThreshold(
        stage.approvalMode,
        stage.requiredApprovals,
        assignees.filter((assignee) => assignee.required).length,
      ),
      approvals: assignees.filter((assignee) => assignee.decision === 'APPROVED').length,
      assignees: assignees.map((assignee) => ({
        userId: assignee.userId,
        displayName: assignee.displayName,
        sequenceNo: assignee.sequenceNo,
        required: assignee.required,
        status: assignee.status,
        decision: assignee.decision,
        actedAt: assignee.actedAt,
        reason: assignee.notes,
        workflowRoleAssignmentId: assignee.workflowRoleAssignmentId,
      })),
      // Whether the signed-in person may act, decided from the session against
      // the persisted assignee list. The decision endpoint checks this again
      // and does not trust the answer travelling back.
      youMayAct:
        instance.status === 'ACTIVE' &&
        assignees.some((assignee) => assignee.userId === you && assignee.actedAt === null),
    });
  } catch (error) {
    return serverError('workflow.stages.get', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
