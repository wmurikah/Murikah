export const prerender = false;

/**
 * Move a work paper to a new status. The executor is the single guard: it
 * requires the action's WORK_PAPERS.* permission, validates the move through the
 * status_transitions engine (allowed, required_role, requires_comment, not
 * terminal), enforces the evidence gate on send-to-auditee, then atomically sets
 * the status, stamps the attribution, writes the append-only revision and the
 * audit row, and enqueues any notification. Scoped to the acting organisation.
 *
 * A submission goes through `submitForReview` rather than straight to the
 * executor (Build Prompt 59), which is the same path the create and edit forms
 * and the batch release take. The transition is unchanged; what is added is the
 * completeness precondition in front of it, and it has to be in front of all
 * four routes or it is in front of none: a gate a second button walks past is
 * not a gate.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { executeTransition, submitForReview } from '@grc/workflow/workPaperWorkflow';
import { WP_STATUS, sameStatus } from '@grc/workflow/workPaperActions';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/work-papers' } });

  const form = await request.formData();
  const toStatus = String(form.get('to_status') ?? '').trim();
  const comment = String(form.get('comment') ?? '').trim() || null;
  // The sender's deliberate "send this without evidence" (Build Prompt 62). The
  // executor honours it only from somebody who holds the override grant.
  const overrideEvidence = String(form.get('evidence_override') ?? '') === '1';
  if (!toStatus) {
    return new Response(null, { status: 303, headers: { location: `/work-papers/${id}` } });
  }

  const db = await getDb(getGrcEnv());
  const actor = {
    userId: grc.userId,
    userName: grc.userName ?? grc.userEmail ?? grc.userId,
    roleCode: grc.roleCode,
    isPlatformOwner: grc.isPlatformOwner,
    matrix: grc.matrix,
    perms: grc.perms,
  };
  const result = sameStatus(toStatus, WP_STATUS.SUBMITTED)
    ? await submitForReview(db, grc.organizationId, id, actor, comment)
    : await executeTransition(
        db,
        grc.organizationId,
        id,
        toStatus,
        actor,
        comment,
        undefined,
        overrideEvidence,
      );

  const location = result.ok
    ? `/work-papers/${id}?done=${encodeURIComponent('Status updated.')}`
    : `/work-papers/${id}?error=${encodeURIComponent(result.message)}`;
  return new Response(null, { status: 303, headers: { location } });
};
