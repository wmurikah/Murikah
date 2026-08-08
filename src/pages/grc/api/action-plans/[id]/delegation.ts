export const prerender = false;

/**
 * The delegated owner accepts or rejects a delegation. The executor guards it:
 * the actor must be a current owner. Accepting records the acceptance; rejecting
 * reverts the owners to the originals (resolved from original_owner_ids) and
 * clears the delegation. Both write history and an audit row. Scoped to the
 * acting organisation.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { decideDelegation } from '@grc/workflow/actionPlanWorkflow';
import { getActionPlan } from '@grc/repos/actionPlans';
import { parseOwnerIds, resolveOwners } from '@grc/repos/actionPlanOwners';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/action-plans' } });

  const form = await request.formData();
  const accept = String(form.get('decision') ?? '').trim() === 'accept';
  const reason = String(form.get('reason') ?? '').trim() || null;

  const db = await getDb(getGrcEnv());
  const plan = await getActionPlan(db, grc.organizationId, id, grc.affiliateScope);
  if (!plan) return new Response(null, { status: 303, headers: { location: '/action-plans' } });

  // Resolve the original owners to revert to on a rejection.
  const originalIds = parseOwnerIds(
    plan.original_owner_ids == null ? null : String(plan.original_owner_ids),
  );
  const originalOwners = accept ? [] : await resolveOwners(db, grc.organizationId, originalIds);

  const result = await decideDelegation(
    db,
    grc.organizationId,
    id,
    {
      userId: grc.userId,
      userName: grc.userName ?? grc.userEmail ?? grc.userId,
      roleCode: grc.roleCode,
      isPlatformOwner: grc.isPlatformOwner,
      perms: grc.perms,
    },
    accept,
    reason,
    originalOwners,
  );

  const message = accept ? 'Delegation accepted.' : 'Delegation rejected.';
  const location = result.ok
    ? `/action-plans/${id}?done=${encodeURIComponent(message)}`
    : `/action-plans/${id}?error=${encodeURIComponent(result.message)}`;
  return new Response(null, { status: 303, headers: { location } });
};
