export const prerender = false;

/**
 * Delete a work paper. Gate: WORK_PAPERS.edit, and only while it is still a draft
 * or in revision (an issued finding is part of the record and is not deleted).
 * Removes the FTS row too, scoped to the acting organisation, and audits it.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getWorkPaper, deleteWorkPaper } from '@grc/repos/workPapers';
import { writeAuditLog } from '@grc/repos/audit';
import { isEditable } from '@grc/workflow/workPaperActions';

export const POST: APIRoute = async ({ params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/work-papers' } });
  if (!grc.perms.includes('WORK_PAPERS.edit')) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/work-papers/${id}?error=${encodeURIComponent('You cannot delete this work paper.')}`,
      },
    });
  }

  const db = await getDb(getGrcEnv());
  const wp = await getWorkPaper(db, grc.organizationId, id);
  if (!wp) return new Response(null, { status: 303, headers: { location: '/work-papers' } });
  if (!isEditable(wp.status)) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/work-papers/${id}?error=${encodeURIComponent('Only a draft or a revision may be deleted.')}`,
      },
    });
  }

  await deleteWorkPaper(db, grc.organizationId, id);
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'WORK_PAPER.delete',
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, {
    status: 303,
    headers: { location: `/work-papers?done=${encodeURIComponent('Work paper deleted.')}` },
  });
};
