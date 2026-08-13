export const prerender = false;

/**
 * A unit manager delegates the drafting of a response to their staff
 * (Build Prompt 68).
 *
 * The authority here is being NAMED as a responsible on the finding, not
 * holding an audit permission: the auditee side has none, and the whole point
 * of this endpoint is that the person it creates standing for has none either.
 * So the guard is the stage machine plus the named lists, and it is enforced
 * server-side whatever the screen offered.
 *
 * The delegation row, the finding's stage and the audit line are one batch, so
 * a delegation never exists against a finding that does not know it happened.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getWorkPaper } from '@grc/repos/workPapers';
import {
  insertDelegationStatement,
  liveDelegation,
  setStageStatement,
} from '@grc/repos/auditeeDelegations';
import { AUDITEE_STAGE, mayMove, nextStage, stageOf } from '@grc/workflow/auditeeLoop';
import { auditeeStanding } from '@grc/repos/auditeeStanding';
import { buildAuditStatement } from '@grc/repos/audit';
import { enqueueNotification } from '@grc/repos/notify';

const back = (id: string, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `/auditee-responses/${id}?${query}` } });

const fail = (id: string, message: string): Response =>
  back(id, `error=${encodeURIComponent(message)}`);

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const workPaperId = String(form.get('work_paper_id') ?? '').trim();
  const delegatedTo = String(form.get('delegated_to') ?? '').trim();
  const instructions = String(form.get('instructions') ?? '').trim() || null;

  if (!workPaperId) {
    return new Response(null, { status: 303, headers: { location: '/auditee-responses' } });
  }
  if (!delegatedTo) return fail(workPaperId, 'Choose the person you are delegating to.');
  if (delegatedTo === grc.userId) {
    return fail(workPaperId, 'You cannot delegate a response to yourself.');
  }

  const db = await getDb(getGrcEnv());
  const wp = await getWorkPaper(db, grc.organizationId, workPaperId, grc.affiliateScope);
  if (!wp) return fail(workPaperId, 'That finding was not found.');

  const standing = await auditeeStanding(db, grc.organizationId, workPaperId, {
    userId: grc.userId,
    isPlatformOwner: grc.isPlatformOwner,
    perms: grc.perms,
  });
  const stage = stageOf(wp.auditee_stage as string | null);
  if (!mayMove(standing, stage, 'delegate')) {
    return fail(
      workPaperId,
      stage === AUDITEE_STAGE.DELEGATED
        ? 'This response is already with a delegate. They must return it before it can be delegated again.'
        : 'Only a responsible on this finding can delegate its response.',
    );
  }
  // Belt and braces against a double submission: the stage says no delegate is
  // holding it, so a live row here means two posts crossed.
  if (await liveDelegation(db, grc.organizationId, workPaperId)) {
    return fail(workPaperId, 'A delegation on this finding is already open.');
  }

  // The delegate has to be a real, active member of this organisation. Reading
  // them back also gives the name the trail and the email show, so neither has
  // to hold an id.
  const target = await db.execute({
    sql: `SELECT user_id, full_name, email FROM users
           WHERE user_id = ? AND organization_id = ? AND deleted_at IS NULL
             AND UPPER(COALESCE(status, '')) NOT IN
                 ('INACTIVE', 'DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED')
           LIMIT 1`,
    args: [delegatedTo, grc.organizationId],
  });
  const row = target.rows[0];
  if (!row) return fail(workPaperId, 'That person is not an active user in your organisation.');
  const delegateName = String(row.full_name ?? row.email ?? delegatedTo);

  const now = new Date().toISOString();
  const delegationId = crypto.randomUUID();
  const round = Number(wp.response_round ?? 1) || 1;
  const userName = grc.userName ?? grc.userEmail ?? grc.userId;
  const to = nextStage(stage, 'delegate') ?? AUDITEE_STAGE.DELEGATED;

  await db.batch(
    [
      insertDelegationStatement(
        grc.organizationId,
        delegationId,
        {
          workPaperId,
          round,
          delegatedBy: grc.userId,
          delegatedByName: userName,
          delegatedTo,
          delegatedToName: delegateName,
          instructions,
        },
        now,
      ),
      setStageStatement(grc.organizationId, workPaperId, to, now),
      buildAuditStatement({
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: 'AUDITEE_RESPONSE.delegate',
        entityType: 'work_paper',
        entityId: workPaperId,
        details: `round ${round} to ${delegatedTo}`,
      }),
    ],
    'write',
  );

  await enqueueNotification(db, {
    organizationId: grc.organizationId,
    templateCode: 'auditee_delegated',
    entityType: 'work_paper',
    entityId: workPaperId,
    actorUserId: grc.userId,
    comment: instructions,
    extra: { stage: 'With the delegate', delegatedTo: delegateName, round: String(round) },
  });

  return back(
    workPaperId,
    `done=${encodeURIComponent(`The response is now with ${delegateName}.`)}`,
  );
};
