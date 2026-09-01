/**
 * POST /api/workflow/stages/{id}/decision on cms.murikah.com.
 *
 * The approver acts. Approve or reject, with optional notes.
 *
 * THE APPROVER IS THE SESSION.
 * `writeContext` takes the acting user from `context.locals.cms`, which the
 * Build Prompt 04 middleware resolved from the session cookie against
 * `auth_sessions`. `recordDecision` has no parameter naming an approver, and
 * `validateDecision` does not read one, so a body carrying `userId`,
 * `approverId` or `actorUserId` is inert: it is not rejected, it is simply
 * never looked at, and the decision is recorded against whoever is signed in.
 *
 * Every other check is made server side too, and none is trusted to the caller:
 * the stage exists, it is ACTIVE, this principal is one of its persisted
 * assignees, they have not already acted, and for a SEQUENTIAL stage it is
 * their turn. A user who is not an assignee is refused with 403 whatever they
 * send, and a stage that has already concluded is refused with 409.
 *
 * There is no permission code on this route. Authority to approve comes from
 * being an assignee of this stage instance, which is a precise fact about this
 * record; an administration permission would be a second, weaker answer to a
 * question the stage already answers exactly.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateDecision } from '../../../../../../lib/cms/admin/workflowInput.ts';
import { recordDecision } from '../../../../../../lib/cms/workflow/runtime.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { apiError, forbidden, notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;

  const parsed = validateDecision(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await recordDecision(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    if (result.ok) {
      // Phase 15: a completed stage stops its SLA, after the decision has
      // committed. The instance names the business entity the stage measures.
      if (result.stageStatus === 'COMPLETED') {
        const parent = await connection.db.execute({
          sql: `SELECT wi.entity_type, wi.entity_id, ws.stage_code
                FROM workflow_stage_instances si
                JOIN workflow_instances wi ON wi.workflow_instance_id = si.workflow_instance_id
                JOIN workflow_stages ws ON ws.workflow_stage_id = si.workflow_stage_id
                WHERE si.workflow_stage_instance_id = ? LIMIT 1`,
          args: [context.params.id ?? ''],
        });
        const row = parent.rows[0];
        const entityType = row === undefined ? '' : String(row.entity_type);
        if (entityType === 'SALES_ORDER' || entityType === 'PURCHASE_ORDER') {
          const { stopWorkflowStageSla } = await import('../../../../../../lib/cms/sla/wiring.ts');
          await stopWorkflowStageSla(connection.db, {
            entityType,
            entityId: String(row?.entity_id ?? ''),
            stageCode: String(row?.stage_code ?? ''),
            at: new Date(),
            actorUserId: auth.principal.user.userId,
          });
        }
      }
      return ok(result);
    }

    switch (result.kind) {
      case 'not_found':
        return notFound('That stage could not be found.');
      case 'not_an_assignee':
        // Deliberately the same message as a stage the caller cannot see, so a
        // refusal does not confirm which stage instances exist.
        return forbidden('You are not an approver of that stage.');
      case 'stage_not_active':
        return apiError('conflict', 'That stage is not open for a decision.', 409);
      case 'already_acted':
        return apiError('conflict', 'You have already recorded a decision on that stage.', 409);
      case 'not_your_turn':
        return apiError('conflict', 'That stage is waiting on an earlier approver.', 409);
    }
  } catch (error) {
    return serverError('workflow.stages.decision', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
