export const prerender = false;

/**
 * Update a work paper's fields. Gate: WORK_PAPERS.edit, and only in an editable
 * state (Draft or Revision Required); any other state is read-only and refused.
 * Scoped to the acting organisation, re-syncs the FTS, writes an audit_log row.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getWorkPaper, updateWorkPaper, parseWorkPaperInput } from '@grc/repos/workPapers';
import { writeAuditLog } from '@grc/repos/audit';
import { isEditable } from '@grc/workflow/workPaperActions';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/work-papers' } });
  if (!grc.perms.includes('WORK_PAPERS.edit')) {
    return new Response(null, {
      status: 303,
      headers: { location: `/work-papers/${id}?error=forbidden` },
    });
  }

  const env = getGrcEnv();
  const db = await getDb(env);
  const wp = await getWorkPaper(db, grc.organizationId, id, grc.affiliateScope);
  if (!wp) return new Response(null, { status: 303, headers: { location: '/work-papers' } });
  if (!isEditable(wp.status)) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/work-papers/${id}?error=${encodeURIComponent('Only a draft or a revision may be edited.')}`,
      },
    });
  }

  const input = parseWorkPaperInput(await request.formData());
  if (!input.observationTitle) {
    return new Response(null, {
      status: 303,
      headers: { location: `/work-papers/${id}/edit?error=invalid` },
    });
  }
  await updateWorkPaper(db, grc.organizationId, id, input);
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'WORK_PAPER.edit',
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, {
    status: 303,
    headers: { location: `/work-papers/${id}?done=${encodeURIComponent('Changes saved.')}` },
  });
};
