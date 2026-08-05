export const prerender = false;

/**
 * Create an action plan. Gate: ACTION_PLANS.create, or AUDITEE.respond for an
 * auditee proposing a plan (recorded as auditee_proposed). Creates the plan
 * scoped to the acting organisation, seeds its owners through setOwners (marking
 * them original), notifies the owners of the assignment, writes an audit_log row,
 * and redirects to the new detail. The organisation and actor come from the
 * verified session.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { createActionPlan, parseActionPlanInput } from '@grc/repos/actionPlans';
import { resolveOwners, setOwners } from '@grc/repos/actionPlanOwners';
import { enqueueNotification } from '@grc/repos/notify';
import { writeAuditLog } from '@grc/repos/audit';
import { getWorkPaper } from '@grc/repos/workPapers';
import { loadAiConfig } from '@grc/ai/config';
import { evaluateAuditeeResponse } from '@grc/ai/features';
import { aiEnabled } from '@grc/ai/gate';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const canCreate = grc.perms.includes('ACTION_PLANS.create');
  const canPropose = grc.perms.includes('AUDITEE.respond');
  if (!canCreate && !canPropose) {
    return new Response(null, {
      status: 303,
      headers: { location: '/action-plans?error=forbidden' },
    });
  }
  const auditeeProposed = !canCreate && canPropose;

  const form = await request.formData();
  const input = parseActionPlanInput(form);
  if (!input.actionDescription) {
    return new Response(null, {
      status: 303,
      headers: { location: '/action-plans/new?error=invalid' },
    });
  }
  const ownerIds = form
    .getAll('owner_ids')
    .map((v) => String(v).trim())
    .filter(Boolean);

  const db = await getDb(getGrcEnv());

  // Auditee auto-evaluation hook: when the plan's AI feature and evaluation are
  // enabled, evaluate an auditee-proposed plan against the finding, and if it
  // scores below the rejection threshold return it with feedback rather than
  // creating it. Best-effort, so AI never blocks a legitimate submission.
  if (auditeeProposed && input.workPaperId && aiEnabled((f) => grc.hasFeature(f))) {
    try {
      const config = await loadAiConfig(db);
      if (config.evaluationEnabled) {
        const wp = await getWorkPaper(db, grc.organizationId, input.workPaperId);
        if (wp) {
          const verdict = await evaluateAuditeeResponse(
            db,
            grc.organizationId,
            grc.userId,
            {
              observation: String(wp.observation_title ?? ''),
              recommendation: String(wp.recommendation ?? ''),
              response: input.actionDescription,
              plans: input.actionDescription,
            },
            config.rejectionThreshold,
            input.workPaperId,
          );
          if (verdict.aiUsed && verdict.autoReject) {
            const msg =
              verdict.feedback ||
              'The proposed action plan did not meet the required standard. Please strengthen it and resubmit.';
            return new Response(null, {
              status: 303,
              headers: { location: `/action-plans/new?error=${encodeURIComponent(msg)}` },
            });
          }
        }
      }
    } catch {
      // best-effort: a failed evaluation must not block the submission.
    }
  }

  const id = await createActionPlan(db, grc.organizationId, grc.userId, input, auditeeProposed);

  if (ownerIds.length > 0) {
    const owners = await resolveOwners(db, grc.organizationId, ownerIds);
    if (owners.length > 0) {
      await setOwners(db, grc.organizationId, id, owners, true);
      await enqueueNotification(db, {
        organizationId: grc.organizationId,
        templateCode: 'action_assigned',
        entityType: 'action_plan',
        entityId: id,
        actorUserId: grc.userId,
      });
    }
  }
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: auditeeProposed ? 'ACTION_PLAN.propose' : 'ACTION_PLAN.create',
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, { status: 303, headers: { location: `/action-plans/${id}` } });
};
