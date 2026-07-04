export const prerender = false;

/**
 * Delegate an action plan to a new owner. The executor guards it: the actor must
 * be an owner and the plan non-terminal. It records the delegation attribution,
 * preserves the original owners, swaps the current owner to the new one through
 * setOwners, writes history and audit rows and notifies the new owner. Scoped to
 * the acting organisation.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { delegate } from '@grc/workflow/actionPlanWorkflow';
import { resolveOwners } from '@grc/repos/actionPlanOwners';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/action-plans' } });

  const form = await request.formData();
  const newOwnerId = String(form.get('new_owner_id') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim() || null;
  if (!newOwnerId) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/action-plans/${id}?error=${encodeURIComponent('Choose an owner to delegate to.')}`,
      },
    });
  }

  const db = await getDb(getGrcEnv());
  const [owner] = await resolveOwners(db, grc.organizationId, [newOwnerId]);
  if (!owner) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/action-plans/${id}?error=${encodeURIComponent('That owner was not found.')}`,
      },
    });
  }

  const result = await delegate(
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
    owner,
    notes,
  );

  const location = result.ok
    ? `/action-plans/${id}?done=${encodeURIComponent('Plan delegated.')}`
    : `/action-plans/${id}?error=${encodeURIComponent(result.message)}`;
  return new Response(null, { status: 303, headers: { location } });
};
