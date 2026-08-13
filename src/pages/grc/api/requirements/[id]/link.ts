export const prerender = false;

/**
 * Link a requirement to the finding its information supports, or unlink it
 * (Build Prompt 69). Gate: REQUIREMENTS.manage.
 *
 * A DIFFERENT DECISION FROM COMPLETENESS. Whether audit has everything it asked
 * for is one question, decided round by round on `/api/requirements/[id]/review`.
 * Whether what arrived is evidence for a particular finding is another, and it
 * is normally answerable later, sometimes much later, and sometimes not at all.
 * Collapsing the two is what forced auditors to name a finding before they had
 * seen a document, which is the habit this endpoint exists to break.
 *
 * The auditee is never party to this. Linking is internal audit structure: the
 * owner who uploaded the reconciliations is not told, is not asked, and does not
 * see it, because which work paper their document ends up supporting is not a
 * question they can answer or should be given.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getRequirement, linkRequirement } from '@grc/repos/requirementsModule';
import { writeAuditLog } from '@grc/repos/audit';

const back = (id: string, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `/requirements/${id}?${query}` } });

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/requirements' } });

  if (!grc.isPlatformOwner && !grc.perms.includes('REQUIREMENTS.manage')) {
    return back(id, `error=${encodeURIComponent('You cannot link requirements to findings.')}`);
  }

  const form = await request.formData();
  // An empty selection is how the screen says "unlink": the auditor decided the
  // information does not belong to the finding after all, and that decision has
  // to be as easy to record as the link was.
  const workPaperId = String(form.get('work_paper_id') ?? '').trim() || null;

  const db = await getDb(getGrcEnv());
  const requirement = await getRequirement(db, grc.organizationId, id);
  if (!requirement) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/requirements?error=${encodeURIComponent('That requirement was not found.')}`,
      },
    });
  }

  const linked = await linkRequirement(db, grc.organizationId, id, workPaperId, grc.userId);
  if (!linked) {
    return back(
      id,
      `error=${encodeURIComponent('That finding was not found in your organisation.')}`,
    );
  }

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: workPaperId ? 'REQUIREMENT.link' : 'REQUIREMENT.unlink',
      entityType: 'requirement',
      entityId: id,
      details: workPaperId ?? 'unlinked',
    });
  } catch {
    // best-effort audit
  }

  return back(
    id,
    `done=${encodeURIComponent(
      workPaperId
        ? 'Linked to the finding. The owner is not told: this is audit structure.'
        : 'Unlinked from the finding.',
    )}`,
  );
};
