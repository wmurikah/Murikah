export const prerender = false;

/**
 * Download one evidence file. After confirming the user may see the evidence
 * (the entity's view permission, a platform owner, or an auditee on their own
 * finding or plan), the worker asks the organisation's own storage provider how
 * to serve it: a provider that can sign a URL (R2) hands one back and the bytes
 * flow straight to the client, and the token-bearing providers stream through
 * the worker. A presigned URL is always scoped to this object's key; it can
 * never reach another tenant's prefix.
 *
 * The provider is resolved from the backend the row records, not from whichever
 * provider is active now (Build Prompt 51), so evidence attached before an
 * administrator switched providers stays downloadable.
 *
 * `?variant=preview` serves the reduced image copy instead, for the evidence
 * thumbnails. It is a hint, not a promise: a non-image, an older file uploaded
 * before previews existed, or a preview that never made it to storage all fall
 * back to the original, so a thumbnail is never a broken image. A preview is
 * inline (it is meant to be rendered); the original is always an attachment.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { planDownload, type StoredObjectRef } from '@grc/storage';
import {
  keyBelongsToOrg,
  safeFilename,
  previewKeyFor,
  isPreviewableImage,
  PREVIEW_CONTENT_TYPE,
} from '@grc/storage/keys';
import { getAttachmentForAccess } from '@grc/repos/evidence';
import { canViewEvidence, type EvidenceActor } from '@grc/storage/access';

const DOWNLOAD_TTL_SECONDS = 120;

export const GET: APIRoute = async ({ params, request, locals }) => {
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

  // A preview only ever exists for an image stored through a connector; the
  // legacy Drive read-through and documents always serve the original.
  const wantsPreview = new URL(request.url).searchParams.get('variant') === 'preview';
  const previewable =
    wantsPreview && att.backend !== 'drive' && isPreviewableImage(att.mimeType ?? '');

  const ref: StoredObjectRef = { backend: att.backend, key };
  try {
    if (previewable) {
      const previewRef: StoredObjectRef = { backend: att.backend, key: previewKeyFor(key) };
      try {
        const preview = await planDownload(
          db,
          grc.organizationId,
          previewRef,
          DOWNLOAD_TTL_SECONDS,
        );
        if (preview.kind === 'redirect') {
          return new Response(null, { status: 302, headers: { location: preview.url } });
        }
        return new Response(preview.body, {
          status: 200,
          headers: {
            'content-type': PREVIEW_CONTENT_TYPE,
            'content-disposition': `inline; filename="${safeFilename(att.fileName)}"`,
          },
        });
      } catch {
        // No preview stored for this file: fall through to the original rather
        // than showing the viewer a broken thumbnail.
      }
    }

    const plan = await planDownload(db, grc.organizationId, ref, DOWNLOAD_TTL_SECONDS);
    if (plan.kind === 'redirect') {
      return new Response(null, { status: 302, headers: { location: plan.url } });
    }
    return new Response(plan.body, {
      status: 200,
      headers: {
        'content-type': att.mimeType ?? 'application/octet-stream',
        'content-disposition': wantsPreview
          ? `inline; filename="${safeFilename(att.fileName)}"`
          : `attachment; filename="${safeFilename(att.fileName)}"`,
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
