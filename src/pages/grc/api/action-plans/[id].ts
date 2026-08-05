export const prerender = false;

/**
 * Update an action plan's fields and owners. Gate: ACTION_PLANS.edit, and only
 * while the plan is not yet verified or closed. Scoped to the acting
 * organisation; re-syncs the owners through setOwners and writes an audit_log
 * row.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getActionPlan, updateActionPlan, parseActionPlanInput } from '@grc/repos/actionPlans';
import { resolveOwners, setOwners } from '@grc/repos/actionPlanOwners';
import { writeAuditLog } from '@grc/repos/audit';
import { isEditableByAuditor } from '@grc/workflow/actionPlanActions';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/action-plans' } });
  if (!grc.perms.includes('ACTION_PLANS.edit')) {
    return new Response(null, {
      status: 303,
      headers: { location: `/action-plans/${id}?error=forbidden` },
    });
  }

  const db = await getDb(getGrcEnv());
  const plan = await getActionPlan(db, grc.organizationId, id);
  if (!plan) return new Response(null, { status: 303, headers: { location: '/action-plans' } });
  if (!isEditableByAuditor(plan.status)) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/action-plans/${id}?error=${encodeURIComponent('A verified or closed plan cannot be edited.')}`,
      },
    });
  }

  const form = await request.formData();
  const input = parseActionPlanInput(form);
  if (!input.actionDescription) {
    return new Response(null, {
      status: 303,
      headers: { location: `/action-plans/${id}/edit?error=invalid` },
    });
  }
  await updateActionPlan(db, grc.organizationId, id, input);

  const ownerIds = form
    .getAll('owner_ids')
    .map((v) => String(v).trim())
    .filter(Boolean);
  const owners = await resolveOwners(db, grc.organizationId, ownerIds);
  await setOwners(db, grc.organizationId, id, owners);

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'ACTION_PLAN.edit',
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, {
    status: 303,
    headers: { location: `/action-plans/${id}?done=${encodeURIComponent('Changes saved.')}` },
  });
};
