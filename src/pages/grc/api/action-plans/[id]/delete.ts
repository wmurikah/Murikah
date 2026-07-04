export const prerender = false;

/**
 * Delete an action plan. Gate: ACTION_PLANS.edit, and only while it is early
 * stage (Not Due, Pending or In Progress); a plan that has reached
 * implementation or review is part of the record and is not deleted. Scoped to
 * the acting organisation and audited.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getActionPlan, deleteActionPlan } from '@grc/repos/actionPlans';
import { writeAuditLog } from '@grc/repos/audit';
import { isDeletable } from '@grc/workflow/actionPlanActions';

export const POST: APIRoute = async ({ params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/action-plans' } });
  if (!grc.perms.includes('ACTION_PLANS.edit')) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/action-plans/${id}?error=${encodeURIComponent('You cannot delete this action plan.')}`,
      },
    });
  }

  const db = await getDb(getGrcEnv());
  const plan = await getActionPlan(db, grc.organizationId, id);
  if (!plan) return new Response(null, { status: 303, headers: { location: '/action-plans' } });
  if (!isDeletable(plan.status)) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/action-plans/${id}?error=${encodeURIComponent('Only an early-stage plan may be deleted.')}`,
      },
    });
  }

  await deleteActionPlan(db, grc.organizationId, id);
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'ACTION_PLAN.delete',
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, {
    status: 303,
    headers: { location: `/action-plans?done=${encodeURIComponent('Action plan deleted.')}` },
  });
};
