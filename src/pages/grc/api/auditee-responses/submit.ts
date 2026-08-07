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
    return back(workPaperId, `error=${encodeURIComponent('You cannot respond to this finding.')}`);
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
    return back(workPaperId, `error=${encodeURIComponent('That finding was not found.')}`);
  }

  // Assignment is the auditee's authority to answer; an auditor reviewing on
  // their behalf is covered by the review permission.
  const assigned = await isAssignedAuditee(db, grc.organizationId, workPaperId, grc.userId);
  if (!assigned && !grc.isPlatformOwner && !grc.perms.includes('WORK_PAPERS.review')) {
    return back(workPaperId, `error=${encodeURIComponent('That finding is not assigned to you.')}`);
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
    ],
    'write',
  );

  try {
    await enqueueNotification(db, {
      organizationId: grc.organizationId,
      templateCode: 'response_received',
      entityType: 'work_paper',
      entityId: workPaperId,
      actorUserId: grc.userId,
    });
  } catch {
    // best-effort: the response is recorded either way.
  }

  return back(
    workPaperId,
    `done=${encodeURIComponent(`Response submitted for round ${round}.`)}&status=${RESPONSE_STATUS.SUBMITTED}`,
  );
};
