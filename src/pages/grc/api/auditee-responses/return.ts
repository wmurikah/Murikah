export const prerender = false;

/**
 * A delegate hands the drafted response back to the unit manager
 * (Build Prompt 68).
 *
 * The delegate's authority is the live delegation row and nothing else: they
 * hold no audit permission, and they are on neither named list. So the guard is
 * "you are holding this delegation", which is what `auditeeStanding` resolves,
 * and returning it is the one move it entitles them to.
 *
 * The delegation closes and the finding's stage moves in one batch, so a return
 * never leaves a delegate still apparently holding work they have handed back.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getWorkPaper } from '@grc/repos/workPapers';
import {
  liveDelegation,
  returnDelegationStatement,
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
  const note = String(form.get('return_note') ?? '').trim() || null;

  if (!workPaperId) {
    return new Response(null, { status: 303, headers: { location: '/auditee-responses' } });
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
  if (!mayMove(standing, stage, 'return_to_manager')) {
    return fail(workPaperId, 'Only the person holding this delegation can return it.');
  }

  const live = await liveDelegation(db, grc.organizationId, workPaperId);
  if (!live) return fail(workPaperId, 'There is no open delegation on this finding.');
  if (live.delegatedTo !== grc.userId && !grc.isPlatformOwner) {
    return fail(workPaperId, 'That delegation is not yours to return.');
  }

  const now = new Date().toISOString();
  const to = nextStage(stage, 'return_to_manager') ?? AUDITEE_STAGE.WITH_UNIT_MANAGER;
  const userName = grc.userName ?? grc.userEmail ?? grc.userId;

  await db.batch(
    [
      returnDelegationStatement(grc.organizationId, live.delegationId, note, now),
      setStageStatement(grc.organizationId, workPaperId, to, now),
      buildAuditStatement({
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: 'AUDITEE_RESPONSE.return',
        entityType: 'work_paper',
        entityId: workPaperId,
        details: `delegation ${live.delegationId} returned`,
      }),
    ],
    'write',
  );

  await enqueueNotification(db, {
    organizationId: grc.organizationId,
    templateCode: 'auditee_returned',
    entityType: 'work_paper',
    entityId: workPaperId,
    actorUserId: grc.userId,
    comment: note,
    extra: { stage: 'With the unit manager', delegatedTo: userName },
  });

  return back(
    workPaperId,
    `done=${encodeURIComponent('The draft is back with the unit manager.')}`,
  );
};
