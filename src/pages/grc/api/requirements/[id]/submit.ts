export const prerender = false;

/**
 * An owner provides what was asked for (Build Prompt 58): a note saying what
 * this is, and the document itself.
 *
 * Gate: being named on the requirement. That is the whole check, deliberately.
 * An owner is routinely an auditee with no audit permission of any kind, and a
 * permission-based gate would either lock them out of the one screen the module
 * exists to give them or hand them the rest of the audit file. The row naming
 * them is the grant.
 *
 * THE BYTES GO WHERE ALL EVIDENCE GOES. The file is stored through the acting
 * organisation's own evidence connector (Build Prompt 51) and recorded in
 * `files` and `file_attachments` under the `requirement` entity, so retention,
 * legal hold, download authorisation and deletion all keep working on it exactly
 * as they do for a finding's evidence. Nothing about a requirement's document
 * is a special case.
 *
 * THE NOTE IS REQUIRED AND THE FILE IS NOT. Some answers are "there is no such
 * policy" or "this is covered by the attachment on round one", and an owner who
 * cannot say so is an owner who invents an upload to escape the form. The
 * screen asks for the document and this records whichever of the two arrives.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { orgProvider } from '@grc/storage';
import { buildObjectKey, keyBelongsToOrg, sha256Hex, CONTENT_HASH_ALGO } from '@grc/storage/keys';
import { recordAttachment } from '@grc/repos/evidence';
import { addSubmission, getRequirement, isRequirementOwner } from '@grc/repos/requirementsModule';
import { requirementNotice } from '@grc/repos/requirementNotice';
import { notifyRequirementSubmitted } from '@grc/notify/requirements';
import { writeAuditLog } from '@grc/repos/audit';

const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

const back = (id: string, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `/requirements/${id}?${query}` } });

export const POST: APIRoute = async ({ request, params, locals }) => {
  const grc = locals.grc;
  const id = params.id;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!id) return new Response(null, { status: 303, headers: { location: '/requirements' } });

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
  if (!(await isRequirementOwner(db, id, grc.userId))) {
    return back(
      id,
      `error=${encodeURIComponent('Only an owner of this requirement may provide it.')}`,
    );
  }
  if (requirement.closedAt) {
    return back(id, `error=${encodeURIComponent('This requirement is closed.')}`);
  }

  const form = await request.formData();
  const note = String(form.get('note') ?? '').trim();
  if (!note) {
    return back(id, `error=${encodeURIComponent('Say what you are providing.')}`);
  }

  // The document, when one was chosen. An empty file input arrives as a zero
  // byte part, which is not an upload and is not stored as one.
  const blob = form.get('file');
  let fileId: string | null = null;
  if (blob instanceof Blob && blob.size > 0) {
    if (blob.size > MAX_EVIDENCE_BYTES) {
      return back(id, `error=${encodeURIComponent('The file exceeds the maximum evidence size.')}`);
    }
    const provider = await orgProvider(db, grc.organizationId);
    if (!provider) {
      return back(
        id,
        `error=${encodeURIComponent('Evidence storage is not configured for your organisation.')}`,
      );
    }
    const fileName = (blob instanceof File ? blob.name : '') || 'requirement-evidence';
    const contentType = blob.type || 'application/octet-stream';
    fileId = crypto.randomUUID();
    const key = buildObjectKey({
      organizationId: grc.organizationId,
      entity: 'requirement',
      entityId: id,
      fileId,
      fileName,
    });
    if (!keyBelongsToOrg(key, grc.organizationId)) {
      return back(id, `error=${encodeURIComponent('The evidence could not be stored.')}`);
    }
    const bytes = await blob.arrayBuffer();
    try {
      const stored = await provider.put(key, bytes, { contentType, fileName });
      await recordAttachment(db, grc.organizationId, {
        fileId,
        entityType: 'requirement',
        entityId: id,
        fileName,
        contentType,
        sizeBytes: bytes.byteLength,
        uploadedBy: grc.userId,
        ref: stored,
        contentHash: await sha256Hex(bytes),
        contentHashAlgo: CONTENT_HASH_ALGO,
      });
    } catch (err) {
      console.error('[grc.requirements.submit] the evidence could not be stored', err);
      return back(id, `error=${encodeURIComponent('The evidence could not be stored.')}`);
    }
  }

  const round = await addSubmission(db, grc.organizationId, id, {
    note,
    fileId,
    submittedBy: grc.userId,
    submittedByName: grc.userName ?? grc.userEmail ?? grc.userId,
  });

  const notice = await requirementNotice(db, grc.organizationId, id, grc.userId);
  if (notice && notice.auditorIds.length > 0) {
    await notifyRequirementSubmitted(db, grc.organizationId, notice.auditorIds, notice);
  }

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'REQUIREMENT.submit',
      entityType: 'requirement',
      entityId: id,
      details: `round ${round}${fileId ? ' with evidence' : ' with no file'}`,
    });
  } catch {
    // best-effort audit
  }

  return back(id, `done=${encodeURIComponent(`Round ${round} sent to audit for review.`)}`);
};
