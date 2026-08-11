export const prerender = false;

/**
 * Raise a requirement: the information audit is asking for, the finding it
 * belongs to, when it is wanted, and who owes it (Build Prompt 58). Gate:
 * REQUIREMENTS.manage. Scoped to the acting organisation, audited, and the
 * named owners are notified that they have been asked.
 *
 * The work paper is required at creation, not optional and not editable into
 * place later: a request for information that hangs off no finding cannot be
 * reported on, cannot be closed as part of anything, and is exactly the loose
 * paperwork the module exists to replace. The repository refuses an id that
 * belongs to another organisation, so a posted value cannot reach across
 * tenants.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { createRequirement } from '@grc/repos/requirementsModule';
import { readDate } from '@grc/repos/requirements';
import { notifyRequirementAssigned } from '@grc/notify/requirements';
import { requirementNotice } from '@grc/repos/requirementNotice';
import { writeAuditLog } from '@grc/repos/audit';

const back = (query: string): Response =>
  new Response(null, { status: 303, headers: { location: `/requirements?${query}` } });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.perms.includes('REQUIREMENTS.manage')) {
    return back(`error=${encodeURIComponent('You cannot raise requirements.')}`);
  }

  const form = await request.formData();
  const workPaperId = String(form.get('work_paper_id') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const ownerIds = form
    .getAll('owner_ids')
    .map((v) => String(v).trim())
    .filter(Boolean);

  if (!workPaperId || !description) {
    return back(`error=${encodeURIComponent('Choose a finding and say what is required.')}`);
  }
  if (ownerIds.length === 0) {
    return back(`error=${encodeURIComponent('Name at least one owner to provide it.')}`);
  }

  const db = await getDb(getGrcEnv());
  const id = await createRequirement(db, grc.organizationId, {
    workPaperId,
    description,
    requestedDate: readDate(form.get('requested_date')),
    dueDate: readDate(form.get('due_date')),
    ownerIds,
    requestedBy: grc.userId,
  });
  if (!id) {
    return back(`error=${encodeURIComponent('That finding was not found in your organisation.')}`);
  }

  const notice = await requirementNotice(db, grc.organizationId, id, grc.userId);
  if (notice) await notifyRequirementAssigned(db, grc.organizationId, ownerIds, notice);

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'REQUIREMENT.create',
      entityType: 'requirement',
      entityId: id,
      details: `${workPaperId}: ${ownerIds.length} owner(s)`,
    });
  } catch {
    // best-effort audit
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: `/requirements/${id}?done=${encodeURIComponent('Requirement raised and the owners notified.')}`,
    },
  });
};
