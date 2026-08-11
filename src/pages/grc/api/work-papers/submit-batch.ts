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
 * The completeness gate applies here exactly as it does to the single Submit
 * (Build Prompt 59), through the same shared path: a draft still missing its
 * risk rating is not releasable because it was ticked in a list rather than
 * opened, and the refusal names the fields rather than failing opaquely.
 *
 * Each finding stands alone: one that cannot move (already submitted by a
 * colleague, incomplete, or outside this auditor's rights) is reported and the
 * rest still go. The redirect says exactly how many moved and names what did not, because
 * "12 of 15 submitted" with no list of the other three is not an answer.
 *
 * The reviewer still gets one email, not one per finding: every submission
 * queues a normal-priority notification and the drain batches them per
 * recipient into a single digest (notify/dispatch.ts).
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { resolveTransitionAccess, submitForReview } from '@grc/workflow/workPaperWorkflow';

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

  // The same access every finding in the batch is decided against, resolved once
  // through the shared accessor rather than per finding: a batch of a hundred is
  // one person's permission asked a hundred times, and asking it once is both
  // cheaper and impossible to answer inconsistently within one batch.
  const access = await resolveTransitionAccess(db, grc.organizationId, actor);

  let submitted = 0;
  const refused: string[] = [];
  for (const id of ids) {
    const result = await submitForReview(db, grc.organizationId, id, actor, null, access);
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
