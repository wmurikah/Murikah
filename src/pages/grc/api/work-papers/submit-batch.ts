export const prerender = false;

/**
 * Submit several draft findings for review in one action (Build Prompt 53).
 *
 * An auditor drafting a week of fieldwork should not have to open twenty
 * findings to release twenty findings. This takes the ids ticked on the work
 * papers list and moves each of them Draft to Submitted.
 *
 * It is deliberately a loop over the same `executeTransition` the single Submit
 * button calls, not a bulk UPDATE, and it holds no permission check of its own:
 * the grant a `Draft -> Submitted` move requires is decided once, in
 * `workPaperActions.ts`, and both paths ask it there (Build Prompt 56). Every
 * finding therefore passes the same gates and leaves the same trail: the move's
 * matrix grant, the `status_transitions` engine (allowed move, required_role,
 * requires_comment, not terminal), its own `work_paper_revisions` row, its own
 * audit line, and its own queued notification. A batch is many submissions, not
 * a different kind of submission, and nothing about being in a batch may weaken
 * a check.
 *
 * Each finding stands alone: one that cannot move (already submitted by a
 * colleague, or outside this auditor's rights) is reported and the rest still
 * go. The redirect says exactly how many moved and names what did not, because
 * "12 of 15 submitted" with no list of the other three is not an answer.
 *
 * The reviewer still gets one email, not one per finding: every submission
 * queues a normal-priority notification and the drain batches them per
 * recipient into a single digest (notify/dispatch.ts).
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { executeTransition } from '@grc/workflow/workPaperWorkflow';
import { WP_STATUS } from '@grc/workflow/workPaperActions';

/** More than a working week of fieldwork in one click is a mistake, not a batch. */
const MAX_BATCH = 100;

const back = (query: string): Response =>
  new Response(null, { status: 303, headers: { location: `/work-papers?${query}` } });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const ids = [
    ...new Set(
      form
        .getAll('work_paper_id')
        .map((v) => String(v).trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) {
    return back(`error=${encodeURIComponent('Select at least one draft to submit.')}`);
  }
  if (ids.length > MAX_BATCH) {
    return back(`error=${encodeURIComponent(`Submit at most ${MAX_BATCH} findings at a time.`)}`);
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

  let submitted = 0;
  const refused: string[] = [];
  for (const id of ids) {
    const result = await executeTransition(
      db,
      grc.organizationId,
      id,
      WP_STATUS.SUBMITTED,
      actor,
      null,
    );
    if (result.ok) submitted += 1;
    else refused.push(`${id}: ${result.message}`);
  }

  if (submitted === 0) {
    return back(`error=${encodeURIComponent(`Nothing was submitted. ${refused[0] ?? ''}`.trim())}`);
  }
  const noun = submitted === 1 ? 'finding' : 'findings';
  const done = `${submitted} ${noun} submitted for review.`;
  if (refused.length > 0) {
    // A partial batch reports both halves in one line: what moved, and what did
    // not with the reason, rather than a count the auditor has to reconcile.
    return back(
      `done=${encodeURIComponent(done)}&error=${encodeURIComponent(
        `${refused.length} could not be submitted. ${refused[0]}`,
      )}`,
    );
  }
  return back(`done=${encodeURIComponent(done)}`);
};
