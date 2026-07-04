export const prerender = false;

/**
 * Manage a work paper's requirements (add, update status, remove). Gate:
 * REQUIREMENTS.manage. Scoped to the acting organisation; every change is
 * audited. Returns to the work paper detail.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { addRequirement, updateRequirement, removeRequirement } from '@grc/repos/requirements';
import { writeAuditLog } from '@grc/repos/audit';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/work-papers' } });
  if (!grc.perms.includes('REQUIREMENTS.manage')) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/work-papers/${id}?error=${encodeURIComponent('You cannot manage requirements.')}`,
      },
    });
  }

  const form = await request.formData();
  const op = String(form.get('op') ?? '');
  const db = await getDb(getGrcEnv());

  if (op === 'add') {
    const description = String(form.get('description') ?? '').trim();
    const status = String(form.get('status') ?? 'OPEN').trim() || 'OPEN';
    if (description) await addRequirement(db, grc.organizationId, id, description, status);
  } else if (op === 'update') {
    const requirementId = String(form.get('requirement_id') ?? '');
    const description = String(form.get('description') ?? '').trim();
    const status = String(form.get('status') ?? '').trim();
    if (requirementId)
      await updateRequirement(db, grc.organizationId, requirementId, description, status);
  } else if (op === 'remove') {
    const requirementId = String(form.get('requirement_id') ?? '');
    if (requirementId) await removeRequirement(db, grc.organizationId, requirementId);
  }

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: `WORK_PAPER.requirement.${op}`,
      details: id,
    });
  } catch {
    // best-effort audit
  }
  return new Response(null, { status: 303, headers: { location: `/work-papers/${id}` } });
};
