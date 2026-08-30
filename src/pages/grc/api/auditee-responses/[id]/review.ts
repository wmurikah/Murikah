export const prerender = false;

/**
 * Review a released response: accept it, modify it, or send it back to the
 * auditee for another round. Gate: WORK_PAPERS.review.
 *
 * Three decisions, not two (Build Prompt 68). "Modify" is audit editing the
 * response and accepting the edited version, which happens constantly at a
 * closing meeting: the wording is nearly right, audit fixes it, and forcing a
 * whole extra round on the unit manager to correct a sentence is how a loop
 * becomes a formality nobody reads. It closes the round like an acceptance and
 * records what was changed, so the trail shows audit's hand rather than
 * presenting audit's words as management's.
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
import {
  AUDITEE_STAGE,
  moveLabel,
  nextStage,
  parseAuditDecision,
  stageOf,
  type AuditDecision,
} from '@grc/workflow/auditeeLoop';
import { setStageStatement } from '@grc/repos/auditeeDelegations';
import { enqueueNotification } from '@grc/repos/notify';

/** What the trail, the email and the confirmation call each decision. */
const DECISION_LABEL: Record<AuditDecision, string> = {
  accept: moveLabel('accept'),
  modify: moveLabel('modify'),
  request_change: moveLabel('request_change'),
};

const DONE_MESSAGE: Record<AuditDecision, (round: number) => string> = {
  accept: () => 'Response accepted and the observation marked reviewed.',
  modify: () => 'Response modified and accepted. The change is recorded on the round.',
  request_change: (round) =>
    `Change requested. The observation is back with the auditee for round ${round}.`,
};

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
  const decision = parseAuditDecision(
    form.get('decision') == null ? null : String(form.get('decision')).trim(),
  );
  const comments = String(form.get('review_comments') ?? '').trim() || null;
  if (!decision) {
    return back(
      '/auditee-responses',
      `error=${encodeURIComponent('Choose accept, modify or request a change.')}`,
    );
  }
  // A modification is audit rewriting management's answer, so it has to say what
  // it changed it to. Recording "modified" with no words would leave a response
  // altered by somebody the trail does not name and for a reason it does not
  // give.
  if (decision === 'modify' && !comments) {
    return back(
      '/auditee-responses',
      `error=${encodeURIComponent('Say what you changed before recording a modification.')}`,
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
  // Accepting and modifying both close the round; only a request for change
  // opens the next one.
  const round = nextRound(
    response.round,
    decision === 'request_change' ? 'request_changes' : 'accept',
  );
  if (decision === 'request_change' && roundsExhausted(round, maxRounds)) {
    return back(
      thread,
      `error=${encodeURIComponent(
        `This observation has used its ${maxRounds} response rounds. Resolve it directly rather than asking for another round.`,
      )}`,
    );
  }

  const now = new Date().toISOString();
  const userName = grc.userName ?? grc.userEmail ?? grc.userId;
  const status = statusForDecision(decision === 'request_change' ? 'request_changes' : 'accept');
  // Where the auditee side stands afterwards: closed on an acceptance or a
  // modification, back with the responsibles when audit wants another round.
  const stage = stageOf(response.auditeeStage);
  const toStage =
    nextStage(stage, decision) ??
    (decision === 'request_change' ? AUDITEE_STAGE.WITH_AUDITEE : AUDITEE_STAGE.CLOSED);

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
      setStageStatement(grc.organizationId, response.workPaperId, toStage, now),
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
  const target =
    decision === 'request_change' ? WP_STATUS.SENT_TO_AUDITEE : WP_STATUS.RESPONSE_REVIEWED;
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
            matrix: grc.matrix,
            perms: grc.perms,
          },
          comments,
        );

  if (!result.ok) {
    return back(
      thread,
      `error=${encodeURIComponent(`The decision was recorded, but the observation could not move: ${result.message}`)}`,
    );
  }
  // Everybody named on the auditee side is told what audit decided, whether or
  // not it is their turn to act: the person who drafted it, the manager who
  // released it and the people copied in all learn the outcome of the thing
  // they worked on (Build Prompt 68).
  await enqueueNotification(db, {
    organizationId: grc.organizationId,
    templateCode: 'auditee_decided',
    entityType: 'work_paper',
    entityId: response.workPaperId,
    actorUserId: grc.userId,
    comment: comments,
    extra: {
      decision: DECISION_LABEL[decision],
      stage: toStage === AUDITEE_STAGE.CLOSED ? 'Closed by audit' : 'With the auditee',
      round: String(round),
    },
  });

  return back(thread, `done=${encodeURIComponent(DONE_MESSAGE[decision](round))}`);
};
