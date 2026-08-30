export const prerender = false;

/**
 * Submit a management response to a finding, the auditee side of the cycle.
 *
 * Two guards, both server-side: the actor must hold AUDITEE.respond (or be an
 * auditor acting on their behalf), and must be assigned to this finding as a
 * responsible or CC recipient, so an auditee can only answer their own work.
 * The finding's move to Response Received is validated against
 * `status_transitions` through the engine's checkTransition, so the transition
 * tables stay the authority; the catalogue's WORK_PAPERS.* permission is not
 * applied here because that gates the auditor's actions, and this actor's
 * authority is their assignment to the finding.
 *
 * The round, the response row, the finding's response fields and the revision
 * trail are written in one batch, so a response never lands half-recorded.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getWorkPaper } from '@grc/repos/workPapers';
import {
  isAssignedAuditee,
  insertResponseStatement,
  stampWorkPaperSubmissionStatement,
} from '@grc/repos/auditeeResponses';
import { checkTransition } from '@grc/workflow/transitions';
import { WORK_PAPER_ENUM_TYPE, WP_STATUS } from '@grc/workflow/workPaperActions';
import { insertRevisionStatement } from '@grc/repos/revisions';
import { buildAuditStatement } from '@grc/repos/audit';
import { enqueueNotification } from '@grc/repos/notify';
import { RESPONSE_STATUS } from '@grc/workflow/responseRounds';
import { AUDITEE_STAGE, mayMove, nextStage, stageOf } from '@grc/workflow/auditeeLoop';
import { auditeeStanding } from '@grc/repos/auditeeStanding';
import { closeDelegationsStatement, setStageStatement } from '@grc/repos/auditeeDelegations';

const back = (id: string, query: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location: `/auditee-responses/${id}?${query}` },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const workPaperId = String(form.get('work_paper_id') ?? '').trim();
  const managementResponse = String(form.get('management_response') ?? '').trim();
  const actionPlanIds =
    form
      .getAll('action_plan_ids')
      .map((v) => String(v).trim())
      .filter(Boolean)
      .join(',') || null;

  if (!workPaperId) {
    return new Response(null, { status: 303, headers: { location: '/auditee-responses' } });
  }
  const mayRespond =
    grc.isPlatformOwner ||
    grc.perms.includes('AUDITEE.respond') ||
    grc.perms.includes('WORK_PAPERS.review');
  if (!mayRespond) {
    return back(
      workPaperId,
      `error=${encodeURIComponent('You cannot respond to this observation.')}`,
    );
  }
  if (!managementResponse) {
    return back(
      workPaperId,
      `error=${encodeURIComponent('Enter your response before submitting.')}`,
    );
  }

  const db = await getDb(getGrcEnv());
  const wp = await getWorkPaper(db, grc.organizationId, workPaperId, grc.affiliateScope);
  if (!wp) {
    return back(workPaperId, `error=${encodeURIComponent('That observation was not found.')}`);
  }

  // Assignment is the auditee's authority to answer; an auditor reviewing on
  // their behalf is covered by the review permission.
  const assigned = await isAssignedAuditee(db, grc.organizationId, workPaperId, grc.userId);
  if (!assigned && !grc.isPlatformOwner && !grc.perms.includes('WORK_PAPERS.review')) {
    return back(
      workPaperId,
      `error=${encodeURIComponent('That observation is not assigned to you.')}`,
    );
  }

  // Releasing is the unit manager's act, and not while a delegate is still
  // drafting (Build Prompt 68). A delegate who has been asked to draft has not
  // been asked to decide the response is finished: they return it, and the
  // manager releases it. The stage machine is what says so.
  const standing = await auditeeStanding(db, grc.organizationId, workPaperId, {
    userId: grc.userId,
    isPlatformOwner: grc.isPlatformOwner,
    perms: grc.perms,
  });
  const stage = stageOf(wp.auditee_stage as string | null);
  const releasing = { ...standing, isResponsible: standing.isResponsible || standing.isAudit };
  if (!mayMove(releasing, stage, 'release_to_audit')) {
    return back(
      workPaperId,
      `error=${encodeURIComponent(
        stage === AUDITEE_STAGE.DELEGATED
          ? 'The delegate must return this draft before it can be released to audit.'
          : 'Only a responsible on this observation can release its response to audit.',
      )}`,
    );
  }

  const fromStatus = String(wp.status);
  const round = Number(wp.response_round ?? 1) || 1;

  // The transition tables decide whether the finding may receive a response now.
  const outcome = await checkTransition(db, WORK_PAPER_ENUM_TYPE, {
    from: fromStatus,
    to: WP_STATUS.RESPONSE_RECEIVED,
    roleCode: grc.roleCode,
    isPlatformOwner: grc.isPlatformOwner,
    comment: managementResponse,
  });
  if (!outcome.ok) {
    return back(workPaperId, `error=${encodeURIComponent(outcome.message)}`);
  }

  const now = new Date().toISOString();
  const responseId = crypto.randomUUID();
  const userName = grc.userName ?? grc.userEmail ?? grc.userId;
  const input = {
    workPaperId,
    round,
    managementResponse,
    submittedById: grc.userId,
    submittedByName: userName,
    actionPlanIds,
  };

  await db.batch(
    [
      insertResponseStatement(grc.organizationId, responseId, input, now),
      stampWorkPaperSubmissionStatement(grc.organizationId, workPaperId, input, now),
      {
        sql: `UPDATE work_papers SET status = ?, updated_at = ?
               WHERE work_paper_id = ? AND organization_id = ?`,
        args: [WP_STATUS.RESPONSE_RECEIVED, now, workPaperId, grc.organizationId],
      },
      insertRevisionStatement({
        workPaperId,
        revisionNumber: Number(wp.revision_count ?? 0) + 1,
        action: 'RESPONSE_SUBMITTED',
        fromStatus,
        toStatus: WP_STATUS.RESPONSE_RECEIVED,
        comments: managementResponse,
        changesSummary: `Round ${round} response submitted`,
        userId: grc.userId,
        userName,
      }),
      buildAuditStatement({
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: 'AUDITEE_RESPONSE.submit',
        entityType: 'work_paper',
        entityId: workPaperId,
        details: `round ${round}`,
      }),
      // The work has left the auditee side, so nobody on it is still holding a
      // brief: a delegate must not keep write access to a response that is
      // already with the reviewer.
      setStageStatement(
        grc.organizationId,
        workPaperId,
        nextStage(stage, 'release_to_audit') ?? AUDITEE_STAGE.WITH_AUDIT,
        now,
      ),
      closeDelegationsStatement(grc.organizationId, workPaperId, now),
    ],
    'write',
  );

  // Everybody named on the auditee side hears that it went, and so does the
  // auditor whose finding it is: a release is the one move in the loop that
  // puts work back on the audit side (Build Prompt 68).
  await enqueueNotification(db, {
    organizationId: grc.organizationId,
    templateCode: 'auditee_released',
    entityType: 'work_paper',
    entityId: workPaperId,
    actorUserId: grc.userId,
    comment: managementResponse,
    extra: { stage: 'With internal audit', round: String(round) },
  });

  return back(
    workPaperId,
    `done=${encodeURIComponent(`Round ${round} released to internal audit.`)}&status=${RESPONSE_STATUS.SUBMITTED}`,
  );
};
