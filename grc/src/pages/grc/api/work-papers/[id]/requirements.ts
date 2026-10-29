export const prerender = false;

/**
 * Manage a work paper's requirements (add, edit, mark received, remove). Gate:
 * REQUIREMENTS.manage. Scoped to the acting organisation; every change is
 * audited. Returns to the work paper detail.
 *
 * A requirement carries what was asked for and the two dates that say where it
 * stands (Build Prompt 52). The status is never submitted: it is derived in the
 * repository from `received_date`, so a row cannot read "Received" with no date
 * of receipt, whatever a form posts.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import {
  addRequirement,
  updateRequirement,
  removeRequirement,
  readDate,
} from '@grc/repos/requirements';
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

  const input = {
    description: String(form.get('description') ?? '').trim(),
    requestedDate: readDate(form.get('requested_date')),
    receivedDate: readDate(form.get('received_date')),
  };

  if (op === 'add') {
    if (input.description) await addRequirement(db, grc.organizationId, id, input);
  } else if (op === 'update') {
    const requirementId = String(form.get('requirement_id') ?? '');
    if (requirementId) await updateRequirement(db, grc.organizationId, requirementId, input);
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
