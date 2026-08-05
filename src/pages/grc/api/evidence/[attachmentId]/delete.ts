export const prerender = false;

/**
 * Request deletion of one evidence file. Deletion is soft and governed: the
 * request is routed through deletion_queue, blocked outright when a legal hold
 * covers the entity, and stamped with the retention floor so the deferred purge
 * honours retention. Nothing is hard-deleted here. The request and any block are
 * written to audit_log. Gate: the entity's edit permission or a platform owner
 * (an auditee cannot delete evidence).
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getAttachmentForAccess } from '@grc/repos/evidence';
import { isUnderLegalHold, retentionFloor, queueDeletion } from '@grc/repos/governance';
import { writeAuditLog } from '@grc/repos/audit';

function entityPath(entityType: string, entityId: string): string {
  const base = entityType === 'action_plan' ? '/action-plans' : '/work-papers';
  return `${base}/${entityId}`;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  const grc = locals.grc;
  if (!grc) return redirect('/login');

  const attachmentId = String(params.attachmentId ?? '').trim();
  if (!attachmentId) return redirect('/work-papers');

  const db = await getDb(getGrcEnv());
  const att = await getAttachmentForAccess(db, grc.organizationId, attachmentId);
  if (!att) return redirect('/work-papers?error=not-found');

  const dest = entityPath(att.entityType, att.entityId);
  const editPerm = att.entityType === 'action_plan' ? 'ACTION_PLANS.edit' : 'WORK_PAPERS.edit';
  if (!grc.isPlatformOwner && !grc.perms.includes(editPerm)) {
    return redirect(`${dest}?error=${encodeURIComponent('You cannot delete this evidence.')}`);
  }

  // A legal hold blocks the request outright; record the attempt.
  if (await isUnderLegalHold(db, att.entityType, att.entityId)) {
    try {
      await writeAuditLog(db, {
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: 'EVIDENCE.delete_blocked_hold',
        details: `${att.entityType}:${att.entityId}:${att.fileId}`,
      });
    } catch {
      // best-effort audit
    }
    return redirect(
      `${dest}?error=${encodeURIComponent('A legal hold blocks deleting this evidence.')}`,
    );
  }

  const form = await request.formData();
  const reason = String(form.get('reason') ?? '').trim() || 'requested by user';
  const retainUntil = await retentionFloor(db, att.entityType, new Date());

  await queueDeletion(db, {
    entityType: att.entityType,
    entityId: att.entityId,
    fileId: att.fileId,
    requestedBy: grc.userId,
    reason,
    retainUntil,
  });
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'EVIDENCE.delete_requested',
      details: `${att.entityType}:${att.entityId}:${att.fileId}`,
    });
  } catch {
    // best-effort audit
  }

  const note = retainUntil
    ? 'Deletion queued; the file is retained until the retention date.'
    : 'Deletion queued.';
  return redirect(`${dest}?done=${encodeURIComponent(note)}`);
};
