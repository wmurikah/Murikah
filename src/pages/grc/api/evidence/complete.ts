export const prerender = false;

/**
 * Complete an evidence upload. The worker recomputes the tenant key from the
 * request (so the client cannot record an arbitrary key), verifies the object
 * exists in R2, computes and stores its sha256 content hash, and writes the
 * files and file_attachments rows. Gate: upload rights on the target entity.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { finaliseUpload } from '@grc/storage';
import { buildObjectKey, keyBelongsToOrg } from '@grc/storage/keys';
import { canUploadEvidence, isDraftEntity, type EvidenceActor } from '@grc/storage/access';
import { recordAttachment } from '@grc/repos/evidence';
import { writeAuditLog } from '@grc/repos/audit';

const ENTITY_TYPES = new Set([
  'work_paper',
  'action_plan',
  'work_paper_draft',
  'action_plan_draft',
]);
// A draft token is client-generated; keep it to a UUID-like shape so it can
// never smuggle path segments into the object key.
const DRAFT_TOKEN_RE = /^[0-9a-fA-F-]{16,64}$/;

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

  if (!ENTITY_TYPES.has(entityType) || !entityId || !fileId || !fileName) {
    return json({ error: 'invalid request' }, 400);
  }
  if (isDraftEntity(entityType) && !DRAFT_TOKEN_RE.test(entityId)) {
    return json({ error: 'invalid request' }, 400);
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

  const key = buildObjectKey({
    organizationId: grc.organizationId,
    entity: entityType,
    entityId,
    fileId,
    fileName,
  });
  if (!keyBelongsToOrg(key, grc.organizationId)) return json({ error: 'forbidden' }, 403);

  const ref = { backend: 'r2', key };
  const finalised = await finaliseUpload(ref);
  if (!finalised) return json({ error: 'The upload did not complete.' }, 409);

  const attachmentId = await recordAttachment(db, grc.organizationId, {
    fileId,
    entityType,
    entityId,
    fileName,
    contentType,
    sizeBytes: finalised.size,
    uploadedBy: grc.userId,
    ref,
    contentHash: finalised.hash,
    contentHashAlgo: finalised.algo,
  });

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
