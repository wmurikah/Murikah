export const prerender = false;

/**
 * Review a submitted response: accept it, or request changes and reopen the
 * finding to the auditee on the next round. Gate: WORK_PAPERS.review.
 *
 * The decision records the reviewer and their comments on the round being
 * judged, then moves the parent finding through the ordinary work-paper
 * transition engine (Response Reviewed on acceptance, back to Sent to Auditee
 * when changes are asked for), so `status_transitions` decides whether the move
 * is allowed, who may make it and whether it needs a comment. The response row
 * and the finding's mirrored round are written first, in one batch, so the trail
 * is consistent even if the engine then refuses the move.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import {
  getResponse,
  reviewResponseStatement,
  stampWorkPaperReviewStatement,
} from '@grc/repos/auditeeResponses';
import {
  parseDecision,
  statusForDecision,
  nextRound,
  roundsExhausted,
  configuredNumber,
  RESPONSE_STATUS,
  DEFAULT_MAX_RESPONSE_ROUNDS,
} from '@grc/workflow/responseRounds';
import { executeTransition } from '@grc/workflow/workPaperWorkflow';
import { WP_STATUS } from '@grc/workflow/workPaperActions';
import { getConfigValues } from '@grc/repos/orgConfig';
import { buildAuditStatement } from '@grc/repos/audit';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const responseId = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!responseId) {
    return new Response(null, { status: 303, headers: { location: '/auditee-responses' } });
  }

  const back = (path: string, query: string): Response =>
    new Response(null, { status: 303, headers: { location: `${path}?${query}` } });

  if (!grc.isPlatformOwner && !grc.perms.includes('WORK_PAPERS.review')) {
    return back(
      '/auditee-responses',
      `error=${encodeURIComponent('You cannot review auditee responses.')}`,
    );
  }

  const form = await request.formData();
  const decision = parseDecision(
    form.get('decision') == null ? null : String(form.get('decision')).trim(),
  );
  const comments = String(form.get('review_comments') ?? '').trim() || null;
  if (!decision) {
    return back(
      '/auditee-responses',
      `error=${encodeURIComponent('Choose accept or request changes.')}`,
    );
  }

  const db = await getDb(getGrcEnv());
  const response = await getResponse(db, grc.organizationId, responseId);
  if (!response) {
    return back(
      '/auditee-responses',
      `error=${encodeURIComponent('That response was not found.')}`,
    );
  }
  const thread = `/auditee-responses/${response.workPaperId}`;

  // A round is decided once. Without this, a stale tab could accept a response
  // that was already sent back, moving the finding on a decision nobody made.
  if (response.status !== RESPONSE_STATUS.SUBMITTED) {
    return back(thread, `error=${encodeURIComponent('That response has already been reviewed.')}`);
  }

  // Requesting changes opens the next round; the allowance caps the loop.
  const config = await getConfigValues(db, grc.organizationId, ['MAX_RESPONSE_ROUNDS']);
  const maxRounds = configuredNumber(
    config.get('MAX_RESPONSE_ROUNDS'),
    DEFAULT_MAX_RESPONSE_ROUNDS,
  );
  const round = nextRound(response.round, decision);
  if (decision === 'request_changes' && roundsExhausted(round, maxRounds)) {
    return back(
      thread,
      `error=${encodeURIComponent(
        `This finding has used its ${maxRounds} response rounds. Resolve it directly rather than asking for another round.`,
      )}`,
    );
  }

  const now = new Date().toISOString();
  const userName = grc.userName ?? grc.userEmail ?? grc.userId;
  const status = statusForDecision(decision);

  await db.batch(
    [
      reviewResponseStatement(
        grc.organizationId,
        responseId,
        status,
        { userId: grc.userId, userName },
        comments,
        now,
      ),
      stampWorkPaperReviewStatement(grc.organizationId, response.workPaperId, status, round, now),
      buildAuditStatement({
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: `AUDITEE_RESPONSE.${decision}`,
        entityType: 'work_paper',
        entityId: response.workPaperId,
        details: `response ${responseId}, round ${response.round}`,
      }),
    ],
    'write',
  );

  // The finding's own status is the engine's call, with its revision row and
  // notification. A refusal leaves the decision recorded and says why.
  //
  // When the finding already sits where the decision would put it (a reviewer
  // clearing an older round while the finding is back with the auditee), there
  // is nothing to move: the round advanced, which is the substance, and asking
  // the engine for a status-to-itself move would only fail.
  const target = decision === 'accept' ? WP_STATUS.RESPONSE_REVIEWED : WP_STATUS.SENT_TO_AUDITEE;
  const result =
    response.workPaperStatus === target
      ? ({ ok: true } as const)
      : await executeTransition(
          db,
          grc.organizationId,
          response.workPaperId,
          target,
          {
            userId: grc.userId,
            userName,
            roleCode: grc.roleCode,
            isPlatformOwner: grc.isPlatformOwner,
            perms: grc.perms,
          },
          comments,
        );

  if (!result.ok) {
    return back(
      thread,
      `error=${encodeURIComponent(`The decision was recorded, but the finding could not move: ${result.message}`)}`,
    );
  }
  const message =
    decision === 'accept'
      ? 'Response accepted and the finding marked reviewed.'
      : `Changes requested. The finding is back with the auditee for round ${round}.`;
  return back(thread, `done=${encodeURIComponent(message)}`);
};
