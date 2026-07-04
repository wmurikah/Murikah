export const prerender = false;

/**
 * Move a work paper to a new status. The executor is the single guard: it
 * requires the action's WORK_PAPERS.* permission, validates the move through the
 * status_transitions engine (allowed, required_role, requires_comment, not
 * terminal), enforces the evidence gate on send-to-auditee, then atomically sets
 * the status, stamps the attribution, writes the append-only revision and the
 * audit row, and enqueues any notification. Scoped to the acting organisation.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { executeTransition } from '@grc/workflow/workPaperWorkflow';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/work-papers' } });

  const form = await request.formData();
  const toStatus = String(form.get('to_status') ?? '').trim();
  const comment = String(form.get('comment') ?? '').trim() || null;
  if (!toStatus) {
    return new Response(null, { status: 303, headers: { location: `/work-papers/${id}` } });
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
    comment,
  );

  const location = result.ok
    ? `/work-papers/${id}?done=${encodeURIComponent('Status updated.')}`
    : `/work-papers/${id}?error=${encodeURIComponent(result.message)}`;
  return new Response(null, { status: 303, headers: { location } });
};
