export const prerender = false;

/**
 * Download one evidence file. After confirming the user may see the evidence
 * (the entity's view permission, a platform owner, or an auditee on their own
 * finding or plan), the worker issues a short-lived presigned GET for an R2
 * object so the bytes flow straight from R2 to the client, or reads a Drive
 * object through the worker. The presigned URL is always scoped to this object's
 * key; it can never reach another tenant's prefix.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { planDownload, type StoredObjectRef } from '@grc/storage';
import { keyBelongsToOrg, safeFilename } from '@grc/storage/keys';
import { getAttachmentForAccess } from '@grc/repos/evidence';
import { canViewEvidence, type EvidenceActor } from '@grc/storage/access';

const DOWNLOAD_TTL_SECONDS = 120;

export const GET: APIRoute = async ({ params, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response('Unauthorised', { status: 401 });

  const attachmentId = String(params.attachmentId ?? '').trim();
  if (!attachmentId) return new Response('Not found', { status: 404 });

  const db = await getDb(getGrcEnv());
  const att = await getAttachmentForAccess(db, grc.organizationId, attachmentId);
  if (!att) return new Response('Not found', { status: 404 });

  const actor: EvidenceActor = {
    userId: grc.userId,
    organizationId: grc.organizationId,
    isPlatformOwner: grc.isPlatformOwner,
    perms: grc.perms,
  };
  if (!(await canViewEvidence(db, actor, att.entityType, att.entityId))) {
    return new Response('Forbidden', { status: 403 });
  }

  const key = att.backend === 'drive' ? att.driveFileId : att.storageKey;
  if (!key) return new Response('Not found', { status: 404 });
  // Defensive: an R2 object must sit inside the acting tenant's prefix.
  if (att.backend !== 'drive' && !keyBelongsToOrg(key, grc.organizationId)) {
    return new Response('Forbidden', { status: 403 });
  }

  const ref: StoredObjectRef = { backend: att.backend, key };
  try {
    const plan = await planDownload(ref, DOWNLOAD_TTL_SECONDS);
    if (plan.kind === 'redirect') {
      return new Response(null, { status: 302, headers: { location: plan.url } });
    }
    return new Response(plan.body, {
      status: 200,
      headers: {
        'content-type': att.mimeType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${safeFilename(att.fileName)}"`,
      },
    });
  } catch (err) {
    // The storage backend refused or is unconfigured: a deliberate, logged
    // unavailability in the same JSON 503 contract the upload endpoints use,
    // never a blank failure.
    console.error('[grc.evidence.download] backend unavailable', err);
    return new Response(JSON.stringify({ error: 'The evidence is not available right now.' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
};
