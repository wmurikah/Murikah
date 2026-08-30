export const prerender = false;

/**
 * Receive evidence bytes directly, for the providers that cannot sign a URL
 * (Build Prompt 51).
 *
 * Google Drive, Microsoft Graph and Dropbox authenticate every call with a
 * bearer token that names the whole connected account. Handing one to a browser
 * so it could upload directly would hand it that account, so on those providers
 * the bytes come here and the worker streams them on. R2 never reaches this
 * route: it signs a URL and the bytes never touch the worker at all.
 *
 * Because the worker already holds the object, this route also finishes the job
 * that /complete does on the presigned path: it hashes the bytes it received,
 * records the files and file_attachments rows, and writes the audit line. One
 * round trip, so there is no window in which the bytes are stored and the
 * record is not.
 *
 * The object key is rebuilt here from the entity and the file id, exactly as
 * /upload-url built it. A client can no more choose a key on this path than on
 * the other one.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { orgProvider } from '@grc/storage';
import {
  buildObjectKey,
  keyBelongsToOrg,
  previewKeyFor,
  sha256Hex,
  CONTENT_HASH_ALGO,
  PREVIEW_CONTENT_TYPE,
} from '@grc/storage/keys';
import { canUploadEvidence, isDraftEntity, type EvidenceActor } from '@grc/storage/access';
import { recordAttachment } from '@grc/repos/evidence';
import { writeAuditLog } from '@grc/repos/audit';

const ENTITY_TYPES = new Set([
  'work_paper',
  'action_plan',
  'work_paper_draft',
  'action_plan_draft',
]);
const DRAFT_TOKEN_RE = /^[0-9a-fA-F-]{16,64}$/;
const FILE_ID_RE = /^[0-9a-fA-F-]{16,64}$/;
const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return json({ error: 'unauthorised' }, 401);

  const form = await request.formData();
  const entityType = String(form.get('entity_type') ?? '').trim();
  const entityId = String(form.get('entity_id') ?? '').trim();
  const fileId = String(form.get('file_id') ?? '').trim();
  const fileName = String(form.get('file_name') ?? '').trim();
  const contentType = String(form.get('content_type') ?? 'application/octet-stream').trim();
  const variant = String(form.get('variant') ?? 'original').trim();
  const blob = form.get('file');

  if (!ENTITY_TYPES.has(entityType) || !entityId || !fileName) {
    return json({ error: 'invalid request' }, 400);
  }
  if (!FILE_ID_RE.test(fileId)) return json({ error: 'invalid request' }, 400);
  if (isDraftEntity(entityType) && !DRAFT_TOKEN_RE.test(entityId)) {
    return json({ error: 'invalid request' }, 400);
  }
  if (!(blob instanceof Blob)) return json({ error: 'invalid request' }, 400);
  if (blob.size > MAX_EVIDENCE_BYTES) {
    return json({ error: 'The file exceeds the maximum evidence size.' }, 413);
  }

  const db = await getDb(getGrcEnv());
  const provider = await orgProvider(db, grc.organizationId);
  if (!provider) {
    return json({ error: 'Evidence storage is not configured for your organisation.' }, 503);
  }

  const actor: EvidenceActor = {
    userId: grc.userId,
    organizationId: grc.organizationId,
    isPlatformOwner: grc.isPlatformOwner,
    perms: grc.perms,
  };
  if (!(await canUploadEvidence(db, actor, entityType, entityId))) {
    return json({ error: 'forbidden' }, 403);
  }

  const key = buildObjectKey({
    organizationId: grc.organizationId,
    entity: entityType,
    entityId,
    fileId,
    fileName,
  });
  if (!keyBelongsToOrg(key, grc.organizationId)) return json({ error: 'forbidden' }, 403);

  const bytes = await blob.arrayBuffer();

  // The preview is a reduced copy of an image, stored beside the original at a
  // derived key. It is best-effort by design: a provider that cannot round-trip
  // the derived key simply has no preview, and the download route falls back to
  // the original rather than showing a broken thumbnail.
  if (variant === 'preview') {
    try {
      await provider.put(previewKeyFor(key), bytes, {
        contentType: PREVIEW_CONTENT_TYPE,
        fileName: `${fileName}.preview.jpg`,
      });
    } catch (err) {
      console.error('[grc.evidence.put] preview rejected', err);
    }
    return json({ ok: true }, 200);
  }

  let stored;
  try {
    stored = await provider.put(key, bytes, { contentType, fileName });
  } catch (err) {
    console.error('[grc.evidence.put] provider rejected the write', err);
    return json({ error: 'The evidence could not be stored.' }, 502);
  }

  // The attach is the point of the upload: bytes in storage with no link row is
  // evidence nobody can see, so a failure here is reported, never swallowed
  // (Build Prompt 65). recordAttachment logs the driver's own reason under
  // [grc.evidence.attach] before it throws.
  let attachmentId: string;
  try {
    attachmentId = await recordAttachment(db, grc.organizationId, {
      fileId,
      entityType,
      entityId,
      fileName,
      contentType,
      sizeBytes: bytes.byteLength,
      uploadedBy: grc.userId,
      // The provider's own reference, not the derived key: Drive and Graph answer
      // with an id of their own, and that is what a later download must ask for.
      ref: stored,
      contentHash: await sha256Hex(bytes),
      contentHashAlgo: CONTENT_HASH_ALGO,
    });
  } catch (err) {
    console.error('[grc.evidence.attach] the attachment was not recorded', err);
    return json({ error: 'The evidence was stored but could not be attached.' }, 502);
  }

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'EVIDENCE.upload',
      details: `${entityType}:${entityId}:${fileId}`,
    });
  } catch {
    // best-effort audit
  }

  return json({ attachmentId }, 200);
};
