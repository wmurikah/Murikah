export const prerender = false;

/**
 * Create a work paper. Gate: WORK_PAPERS.create. Creates the draft scoped to the
 * acting organisation, syncs the FTS row, writes an audit_log row, and redirects
 * to the new detail. The organisation and actor come from the verified session.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { createWorkPaper, parseWorkPaperInput } from '@grc/repos/workPapers';
import { writeAuditLog } from '@grc/repos/audit';
import { bindDraftAttachments, ensureDeterministicNames } from '@grc/repos/evidence';
import { WP_STATUS } from '@grc/workflow/workPaperActions';

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
      // The bound files get their deterministic display names now that the
      // parent exists; the cron sweep mirrors them to Drive.
      await ensureDeterministicNames(db, grc.organizationId, 'work_paper', id);
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
  return new Response(null, { status: 303, headers: { location: `/work-papers/${id}` } });
};
