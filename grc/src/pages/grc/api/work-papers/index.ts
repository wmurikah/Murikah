export const prerender = false;

/**
 * Create a work paper. Gate: WORK_PAPERS.create. Creates the draft scoped to the
 * acting organisation, syncs the FTS row, writes an audit_log row, and redirects
 * to the new detail. The organisation and actor come from the verified session.
 *
 * Two buttons, two acts (Build Prompt 59). Save as draft keeps whatever has been
 * written, however unfinished; Submit for review saves and then submits the
 * finding through the same path every Submit runs through, which refuses an
 * incomplete finding and names what is missing. The save happens either way, so
 * a refused submission never costs the auditor their work.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { createWorkPaper, parseWorkPaperInput } from '@grc/repos/workPapers';
import { writeAuditLog } from '@grc/repos/audit';
import { bindDraftAttachments } from '@grc/repos/evidence';
import { WP_STATUS } from '@grc/workflow/workPaperActions';
import { submitForReview } from '@grc/workflow/workPaperWorkflow';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.perms.includes('WORK_PAPERS.create')) {
    return new Response(null, {
      status: 303,
      headers: { location: '/work-papers?error=forbidden' },
    });
  }

  const form = await request.formData();
  const input = parseWorkPaperInput(form);
  if (!input.observationTitle) {
    return new Response(null, {
      status: 303,
      headers: { location: '/work-papers/new?error=invalid' },
    });
  }

  const env = getGrcEnv();
  const db = await getDb(env);
  const id = await createWorkPaper(db, grc.organizationId, grc.userId, WP_STATUS.DRAFT, input);

  // Evidence staged on the create form (against the draft token) becomes this
  // finding's evidence. Best-effort: a failed bind never loses the finding.
  const draftToken = String(form.get('draft_token') ?? '').trim();
  if (draftToken !== '') {
    try {
      await bindDraftAttachments(
        db,
        grc.organizationId,
        grc.userId,
        'work_paper_draft',
        draftToken,
        'work_paper',
        id,
      );
    } catch (err) {
      console.error('[grc.evidence.bind] draft binding failed', err);
    }
  }
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'WORK_PAPER.create',
      details: id,
    });
  } catch {
    // best-effort audit
  }
  // Submitting is saving plus one more step, and the step is the shared one, so
  // the completeness gate and the transition are identical to the detail's own
  // Submit and to the batch release.
  if (String(form.get('intent') ?? '') === 'submit') {
    const result = await submitForReview(db, grc.organizationId, id, {
      userId: grc.userId,
      userName: grc.userName ?? grc.userEmail ?? grc.userId,
      roleCode: grc.roleCode,
      isPlatformOwner: grc.isPlatformOwner,
      matrix: grc.matrix,
      perms: grc.perms,
    });
    if (!result.ok) {
      // The finding exists and is safe; the edit screen is where the missing
      // fields are filled in, so that is where the refusal lands.
      return new Response(null, {
        status: 303,
        headers: {
          location: `/work-papers/${id}/edit?error=${encodeURIComponent(
            `Saved as a draft. ${result.message}`,
          )}`,
        },
      });
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: `/work-papers/${id}?done=${encodeURIComponent('Submitted for review.')}`,
      },
    });
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/work-papers/${id}?done=${encodeURIComponent('Saved as a draft.')}` },
  });
};
