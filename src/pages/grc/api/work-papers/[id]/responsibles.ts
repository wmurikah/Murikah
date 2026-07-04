export const prerender = false;

/**
 * Manage a work paper's responsibles (with role_in_finding) and CC recipients.
 * Gate: WORK_PAPERS.edit. Scoped to the acting organisation; audited. Returns to
 * the work paper detail.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import {
  addResponsible,
  removeResponsible,
  addCcRecipient,
  removeCcRecipient,
} from '@grc/repos/responsibles';
import { writeAuditLog } from '@grc/repos/audit';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/work-papers' } });
  if (!grc.perms.includes('WORK_PAPERS.edit')) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/work-papers/${id}?error=${encodeURIComponent('You cannot change responsibles.')}`,
      },
    });
  }

  const form = await request.formData();
  const op = String(form.get('op') ?? '');
  const db = await getDb(getGrcEnv());

  if (op === 'add_responsible') {
    const userId = String(form.get('user_id') ?? '');
    const role = String(form.get('role_in_finding') ?? 'PRIMARY').trim() || 'PRIMARY';
    if (userId) await addResponsible(db, grc.organizationId, id, userId, role);
  } else if (op === 'remove_responsible') {
    const responsibleId = String(form.get('responsible_id') ?? '');
    if (responsibleId) await removeResponsible(db, grc.organizationId, responsibleId);
  } else if (op === 'add_cc') {
    const userId = String(form.get('user_id') ?? '');
    if (userId) await addCcRecipient(db, grc.organizationId, id, userId);
  } else if (op === 'remove_cc') {
    const ccId = String(form.get('cc_id') ?? '');
    if (ccId) await removeCcRecipient(db, grc.organizationId, ccId);
  }

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: `WORK_PAPER.responsible.${op}`,
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, { status: 303, headers: { location: `/work-papers/${id}` } });
};
