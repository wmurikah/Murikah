export const prerender = false;

/**
 * Issue a presigned PUT URL for a new evidence object, scoped to the exact tenant
 * key, only after checking the user may upload to the target work paper or action
 * plan. The large bytes go straight from the client to R2; the worker records
 * nothing yet. The client keeps the returned file_id and calls /complete once the
 * PUT succeeds. Gate: upload rights on the target entity (auditor edit permission,
 * platform owner, or an auditee on their own finding or plan).
 *
 * For an image the response also carries a second presigned URL for the preview
 * object: a copy reduced to one constant dimension (storage/keys.ts) that the
 * evidence lists show as a thumbnail, so a wall of them is uniform and light
 * while the original stays untouched. The preview key is derived from the
 * original's, so nothing has to be stored to find it again. The client is
 * trusted only with the bytes, never with the key: both keys are computed here.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { storageConfigured, presignUpload } from '@grc/storage';
import {
  buildObjectKey,
  keyBelongsToOrg,
  previewKeyFor,
  isPreviewableImage,
  PREVIEW_MAX_DIMENSION,
  PREVIEW_CONTENT_TYPE,
} from '@grc/storage/keys';
import { canUploadEvidence, isDraftEntity, type EvidenceActor } from '@grc/storage/access';

const ENTITY_TYPES = new Set([
  'work_paper',
  'action_plan',
  'work_paper_draft',
  'action_plan_draft',
]);
// A draft token is client-generated; keep it to a UUID-like shape so it can
// never smuggle path segments into the object key.
const DRAFT_TOKEN_RE = /^[0-9a-fA-F-]{16,64}$/;

const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 300;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return json({ error: 'unauthorised' }, 401);
  if (!storageConfigured()) return json({ error: 'Evidence storage is not configured.' }, 503);

  const form = await request.formData();
  const entityType = String(form.get('entity_type') ?? '').trim();
  const entityId = String(form.get('entity_id') ?? '').trim();
  const fileName = String(form.get('file_name') ?? '').trim();
  const contentType = String(form.get('content_type') ?? 'application/octet-stream').trim();
  const sizeBytes = Number(form.get('size_bytes') ?? 0);

  if (!ENTITY_TYPES.has(entityType) || !entityId || !fileName) {
    return json({ error: 'invalid request' }, 400);
  }
  if (isDraftEntity(entityType) && !DRAFT_TOKEN_RE.test(entityId)) {
    return json({ error: 'invalid request' }, 400);
  }
  if (Number.isFinite(sizeBytes) && sizeBytes > MAX_EVIDENCE_BYTES) {
    return json({ error: 'The file exceeds the maximum evidence size.' }, 413);
  }

  const db = await getDb(getGrcEnv());
  const actor: EvidenceActor = {
    userId: grc.userId,
    organizationId: grc.organizationId,
    isPlatformOwner: grc.isPlatformOwner,
    perms: grc.perms,
  };
  if (!(await canUploadEvidence(db, actor, entityType, entityId))) {
    return json({ error: 'forbidden' }, 403);
  }

  const fileId = crypto.randomUUID();
  const key = buildObjectKey({
    organizationId: grc.organizationId,
    entity: entityType,
    entityId,
    fileId,
    fileName,
  });
  // Defensive: a key must always sit inside the acting tenant's prefix.
  if (!keyBelongsToOrg(key, grc.organizationId)) return json({ error: 'forbidden' }, 403);

  try {
    const url = await presignUpload(key, UPLOAD_TTL_SECONDS);
    // Only for an image, and only ever alongside the original: a preview URL is
    // useless on its own, because /complete records the original's key.
    const previewUrl = isPreviewableImage(contentType)
      ? await presignUpload(previewKeyFor(key), UPLOAD_TTL_SECONDS)
      : null;
    return json(
      {
        fileId,
        backend: 'r2',
        method: 'PUT',
        url,
        contentType,
        previewUrl,
        previewContentType: PREVIEW_CONTENT_TYPE,
        previewMaxDimension: PREVIEW_MAX_DIMENSION,
      },
      200,
    );
  } catch {
    return json({ error: 'Could not prepare the upload.' }, 502);
  }
};
