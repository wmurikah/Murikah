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
import { createActionPlan, type ActionPlanInput } from '@grc/repos/actionPlans';
import { resolveOwners, setOwners } from '@grc/repos/actionPlanOwners';
import { enqueueNotification } from '@grc/repos/notify';
import { writeAuditLog } from '@grc/repos/audit';

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
  const input: ActionPlanInput = {
    workPaperId: String(form.get('work_paper_id') ?? '').trim() || null,
    actionDescription: String(form.get('action_description') ?? '').trim(),
    dueDate: String(form.get('due_date') ?? '').trim() || null,
  };
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
