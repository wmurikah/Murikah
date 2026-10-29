/**
 * POST /api/admin/approval-preview on cms.murikah.com.
 *
 * Answers "who would approve this?" for a hypothetical transaction, stage by
 * stage, with the reason for each.
 *
 * IT CALLS THE SAME RESOLVER AS THE LIVE PATH. There is no preview
 * implementation. `resolveStagePreview` below assembles the stages and hands
 * each one to ../../../lib/cms/workflow/resolver.ts, which is the function
 * ../../../lib/cms/workflow/runtime.ts calls when a stage instance is actually
 * created. A preview with its own logic would certify a configuration that
 * behaves differently in production, which is worse than no preview.
 *
 * IT WRITES NOTHING, AND IT AUDITS NOTHING. `APPROVER_RESOLVED` fires when a
 * stage instance is assigned, not here: an administrator trying six amounts to
 * find where a threshold bites would otherwise fill the audit table with
 * experiments and bury the approvals that matter.
 *
 * The full resolution trace is returned, because this is an administrative
 * screen behind ADMIN.WORKFLOWS.MANAGE or ADMIN.WORKFLOW_ROLES.MANAGE. A normal
 * approver never sees it; they see the one-sentence reason.
 */
import type { APIRoute } from 'astro';
import type { Client } from '@libsql/client/web';
import { requireWorkflowView } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { validatePreview } from '../../../../lib/cms/admin/workflowInput.ts';
import {
  getDefinition,
  listStages,
  pickDefinition,
  type StageRow,
  type WorkflowDefinitionRow,
} from '../../../../lib/cms/repos/workflowAdmin.ts';
import { resolveApprovers, type Resolution } from '../../../../lib/cms/workflow/resolver.ts';
import { approvalThreshold } from '../../../../lib/cms/workflow/runtime.ts';
import type { TransactionContext } from '../../../../lib/cms/workflow/runtime.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../lib/cms/errors.ts';
import { isoDay } from '../../../../lib/cms/workflow/model.ts';

export const prerender = false;

interface StagePreview {
  readonly stageCode: string;
  readonly stageName: string;
  readonly sequenceNo: number;
  readonly assignmentType: string;
  readonly approvalMode: string;
  readonly requiredApprovals: number;
  readonly threshold: number;
  readonly outcome: 'resolved' | 'exception' | 'not_applicable';
  readonly approvers: readonly {
    userId: string;
    displayName: string;
    reason: string;
    assignmentId: string;
    authorityRuleId: string | null;
    scopeType: string;
    unrestricted: boolean;
  }[];
  readonly exception: { reason: string; message: string } | null;
  readonly trace: Resolution['trace'] | null;
}

async function previewStage(
  db: Client,
  stage: StageRow,
  context: TransactionContext,
): Promise<StagePreview> {
  const base = {
    stageCode: stage.stageCode,
    stageName: stage.stageName,
    sequenceNo: stage.sequenceNo,
    assignmentType: stage.assignmentType,
    approvalMode: stage.approvalMode,
    requiredApprovals: stage.requiredApprovals,
  };

  // A stage that does not resolve against a workflow role has nothing for the
  // authority resolver to decide: a named user, a team or a system step is its
  // own answer. Saying so is more useful than showing an empty approver list.
  if (stage.assignmentType !== 'WORKFLOW_ROLE' || stage.assignedWorkflowRoleId === null) {
    return {
      ...base,
      threshold: approvalThreshold(stage.approvalMode, stage.requiredApprovals, 1),
      outcome: 'not_applicable',
      approvers: [],
      exception: null,
      trace: null,
    };
  }

  const resolution = await resolveApprovers(db, {
    processType: context.processType,
    workflowRoleId: stage.assignedWorkflowRoleId,
    countryId: context.countryId,
    affiliateId: context.affiliateId,
    businessUnitId: context.businessUnitId,
    amount: context.amount,
    currencyCode: context.currencyCode,
    lines: context.lines,
    eventDate: context.eventDate,
  });

  if (resolution.outcome === 'exception') {
    return {
      ...base,
      threshold: 0,
      outcome: 'exception',
      approvers: [],
      exception: { reason: resolution.reason, message: resolution.message },
      trace: resolution.trace,
    };
  }

  return {
    ...base,
    threshold: approvalThreshold(
      stage.approvalMode,
      stage.requiredApprovals,
      resolution.approvers.length,
    ),
    outcome: 'resolved',
    approvers: resolution.approvers.map((approver) => ({
      userId: approver.userId,
      displayName: approver.displayName,
      reason: approver.reason,
      assignmentId: approver.assignmentId,
      authorityRuleId: approver.ruleId,
      scopeType: approver.scopeType,
      unrestricted: approver.unrestricted,
    })),
    exception: null,
    trace: resolution.trace,
  };
}

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const parsed = validatePreview(await readJson(context.request), isoDay(new Date()));
  if (!parsed.ok) return invalid(parsed.errors);
  const { context: transaction, workflowDefinitionId } = parsed.value;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const definition: WorkflowDefinitionRow | null =
      workflowDefinitionId === null
        ? await pickDefinition(connection.db, {
            processType: transaction.processType,
            countryId: transaction.countryId,
            affiliateId: transaction.affiliateId,
            businessUnitId: transaction.businessUnitId,
            onDate: transaction.eventDate,
          })
        : await getDefinition(connection.db, workflowDefinitionId);

    if (definition === null) {
      return notFound('No workflow applies to that process and organisation on that date.');
    }

    const stages = await listStages(connection.db, definition.workflowDefinitionId);
    const previews: StagePreview[] = [];
    for (const stage of stages) {
      previews.push(await previewStage(connection.db, stage, transaction));
    }

    return ok({ definition, context: transaction, stages: previews });
  } catch (error) {
    return serverError('admin.approvalPreview', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
