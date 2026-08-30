export const prerender = false;

/**
 * Audit's decision on the latest round (Build Prompt 58): accept it, which ends
 * the ask, or say what is still missing, which sends it back to the owners for
 * another round. Gate: REQUIREMENTS.manage. Scoped to the acting organisation
 * and audited.
 *
 * REQUESTING MORE CARRIES THE QUESTION. A decision that only says "not enough"
 * puts the owner back where they started, guessing. The additional-information
 * request is required on that branch and is what the owner answers next round;
 * the review comment beside it is the reasoning, which is a different thing and
 * is optional.
 *
 * Accepting is refused when nothing has been provided: closing a requirement
 * nobody answered would record an information request as satisfied by silence,
 * which is the one outcome an audit file must never claim.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import {
  getRequirement,
  requirementOwnerIds,
  reviewLatestRound,
} from '@grc/repos/requirementsModule';
import { isReviewDecision } from '@grc/workflow/requirementFlow';
import { requirementNotice } from '@grc/repos/requirementNotice';
import { notifyRequirementMoreInfo } from '@grc/notify/requirements';
import { writeAuditLog } from '@grc/repos/audit';

const back = (id: string, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `/requirements/${id}?${query}` } });

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/requirements' } });
  if (!grc.perms.includes('REQUIREMENTS.manage')) {
    return back(id, `error=${encodeURIComponent('You cannot review requirements.')}`);
  }

  const form = await request.formData();
  const decision = String(form.get('decision') ?? '').trim();
  if (!isReviewDecision(decision)) {
    return back(id, `error=${encodeURIComponent('Choose to accept it or ask for more.')}`);
  }
  const comment = String(form.get('review_comment') ?? '').trim() || null;
  const additional = String(form.get('additional_info_request') ?? '').trim() || null;
  if (decision === 'more_info' && !additional) {
    return back(id, `error=${encodeURIComponent('Say what further information is needed.')}`);
  }

  const db = await getDb(getGrcEnv());
  const requirement = await getRequirement(db, grc.organizationId, id);
  if (!requirement) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/requirements?error=${encodeURIComponent('That requirement was not found.')}`,
      },
    });
  }

  const reviewed = await reviewLatestRound(db, grc.organizationId, id, {
    decision,
    comment,
    additionalInfoRequest: additional,
    reviewedBy: grc.userId,
    reviewedByName: grc.userName ?? grc.userEmail ?? grc.userId,
  });
  if (!reviewed) {
    return back(id, `error=${encodeURIComponent('There is nothing provided to review yet.')}`);
  }

  if (decision === 'more_info') {
    const notice = await requirementNotice(db, grc.organizationId, id, grc.userId);
    const owners = await requirementOwnerIds(db, id);
    if (notice && owners.length > 0) {
      await notifyRequirementMoreInfo(db, grc.organizationId, owners, {
        ...notice,
        additionalInfoRequest: additional,
      });
    }
  }

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: `REQUIREMENT.${decision}`,
      entityType: 'requirement',
      entityId: id,
      details: decision === 'accept' ? 'closed' : 'returned for more information',
    });
  } catch {
    // best-effort audit
  }

  const done =
    decision === 'accept'
      ? 'Requirement accepted and closed.'
      : 'The owners have been asked for more information.';
  return back(id, `done=${encodeURIComponent(done)}`);
};
