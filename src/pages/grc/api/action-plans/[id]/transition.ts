export const prerender = false;

/**
 * Move an action plan to a new status (mark implemented, verify, return for
 * rework, reject, approve and close, reject verification). The executor is the
 * single guard: it checks the action's permission or ownership, validates the
 * move through the status_transitions engine (allowed, required_role,
 * requires_comment, not terminal), enforces the evidence gate on mark-implemented,
 * then atomically sets the status, applies the per-action effect (implementation
 * notes, or the auditor or Head-of-Audit review), writes the history and audit
 * rows and enqueues a notification. Scoped to the acting organisation.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { executeTransition } from '@grc/workflow/actionPlanWorkflow';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/action-plans' } });

  const form = await request.formData();
  const toStatus = String(form.get('to_status') ?? '').trim();
  const comment = String(form.get('comment') ?? '').trim() || null;
  const implementationNotes = String(form.get('implementation_notes') ?? '').trim() || null;
  if (!toStatus) {
    return new Response(null, { status: 303, headers: { location: `/action-plans/${id}` } });
  }

  const db = await getDb(getGrcEnv());
  const result = await executeTransition(
    db,
    grc.organizationId,
    id,
    toStatus,
    {
      userId: grc.userId,
      userName: grc.userName ?? grc.userEmail ?? grc.userId,
      roleCode: grc.roleCode,
      isPlatformOwner: grc.isPlatformOwner,
      perms: grc.perms,
    },
    { comment, implementationNotes },
  );

  const location = result.ok
    ? `/action-plans/${id}?done=${encodeURIComponent('Action plan updated.')}`
    : `/action-plans/${id}?error=${encodeURIComponent(result.message)}`;
  return new Response(null, { status: 303, headers: { location } });
};
