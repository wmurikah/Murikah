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
 *
 * A caller may pass `return_to` to come back where it started (the Kanban board
 * drops a card this way). It is accepted only when it is a root-relative
 * /action-plans path, so it can never become an open redirect.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { executeTransition } from '@grc/workflow/actionPlanWorkflow';
import { safeReturnPath } from '@grc/repos/actionPlanInput';

/** The page to return to, confined to the action-plans area. */
const safeReturnTo = (raw: string | null, id: string): string =>
  safeReturnPath(raw, '/action-plans', `/action-plans/${id}`);

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/action-plans' } });

  const form = await request.formData();
  const toStatus = String(form.get('to_status') ?? '').trim();
  const comment = String(form.get('comment') ?? '').trim() || null;
  const implementationNotes = String(form.get('implementation_notes') ?? '').trim() || null;
  const returnTo = safeReturnTo(
    form.get('return_to') == null ? null : String(form.get('return_to')),
    id,
  );
  if (!toStatus) {
    return new Response(null, { status: 303, headers: { location: returnTo } });
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

  const sep = returnTo.includes('?') ? '&' : '?';
  const location = result.ok
    ? `${returnTo}${sep}done=${encodeURIComponent('Action plan updated.')}`
    : `${returnTo}${sep}error=${encodeURIComponent(result.message)}`;
  return new Response(null, { status: 303, headers: { location } });
};
