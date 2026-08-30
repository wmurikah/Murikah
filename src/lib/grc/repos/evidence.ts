/**
 * Evidence metadata for work papers and their requirements, recorded through
 * `files` and `file_attachments`, scoped to the acting organisation. The bytes
 * live behind the storage interface (src/lib/grc/storage.ts), which is
 * deliberately not wired until the Google Drive vs R2 decision is made; this
 * module only reads and writes the metadata, so the detail can list evidence and
 * a chosen backend can be attached in one place later.
 *
 * Column names come from the typed schema layer. The organisation scope lives on
 * `files.organization_id`; `file_attachments` is the link table (attachment_id,
 * file_id, entity_type, entity_id, file_category, attached_by, attached_at) and
 * carries no organisation of its own.
 */
import type { Client } from '@libsql/client/web';
import type { StoredObjectRef } from '@grc/storage';
import { C, cols } from '@grc/schema/columns';

const F = cols(C.files);
const FA = cols(C.file_attachments);

/**
 * The value `file_attachments.entity_type` actually carries (Build Prompt 65).
 *
 * The link table names the kind of record evidence hangs off, and the live
 * database spells those in upper case: a work paper's evidence is
 * `WORK_PAPER`. The application's own token for the same thing is lower case,
 * because that is what the routes, the access rules and the object keys use, so
 * this is the one place the two meet. Writing through it and reading through it
 * means the write and the read cannot disagree about what a work paper's
 * evidence is called, which is the fault that leaves evidence invisible.
 */
export function storedEntityType(entityType: string): string {
  return String(entityType ?? '')
    .trim()
    .toUpperCase();
}

/**
 * The predicate that matches a stored entity type, whatever case it was written
 * in. Rows written before this convention was settled carry the lower-case
 * token, and they are the same evidence; a reader that saw only one spelling
 * would hide half the audit file.
 */
const SAME_ENTITY_TYPE = `TRIM(UPPER(${FA.entity_type})) = ?`;

/**
 * What "attached to this entity" means, written once (Build Prompt 62).
 *
 * The organisation scope lives on `files`, not on the `file_attachments` link
 * table, which carries no organisation of its own, so it is reached through the
 * join. Bound in the order: organisation, entity type, entity id.
 */
const ATTACHED_TO =
  `f.${F.organization_id} = ? AND f.${F.deleted_at} IS NULL ` +
  `AND TRIM(UPPER(fa.${FA.entity_type})) = ? AND fa.${FA.entity_id} = ?`;

/** The evidence category every attachment this module writes carries. */
export const EVIDENCE_CATEGORY = 'EVIDENCE';

/** The tag an attachment failure is logged under. */
const ATTACH_TAG = '[grc.evidence.attach]';

export interface Attachment {
  attachmentId: string;
  fileId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  backend: string | null;
  uploadedBy: string | null;
  createdAt: string | null;
}

/** List the evidence attached to an entity (a work paper or a requirement). */
export async function listAttachments(
  db: Client,
  organizationId: string,
  entityType: string,
  entityId: string,
): Promise<Attachment[]> {
  const res = await db.execute({
    sql: `SELECT fa.${FA.attachment_id} AS attachment_id, f.${F.file_id} AS file_id,
                 f.${F.file_name} AS file_name, f.${F.mime_type} AS mime_type,
                 f.${F.size_bytes} AS size_bytes, f.${F.storage_backend} AS backend,
                 f.${F.uploaded_by} AS uploaded_by, f.${F.created_at} AS created_at
            FROM file_attachments fa
            JOIN files f ON f.${F.file_id} = fa.${FA.file_id}
           WHERE ${ATTACHED_TO}
        ORDER BY f.${F.created_at} DESC`,
    args: [organizationId, storedEntityType(entityType), entityId],
  });
  return res.rows.map((r) => ({
    attachmentId: String(r.attachment_id),
    fileId: String(r.file_id),
    fileName: String(r.file_name ?? ''),
    mimeType: r.mime_type == null ? null : String(r.mime_type),
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    backend: r.backend == null ? null : String(r.backend),
    uploadedBy: r.uploaded_by == null ? null : String(r.uploaded_by),
    createdAt: r.created_at == null ? null : String(r.created_at),
  }));
}

/**
 * How many pieces of evidence are attached to an entity: the same records
 * `listAttachments` lists, counted by the same predicate (Build Prompt 62).
 *
 * The send-to-auditee gate asks this. It used to ask a COUNT of its own, written
 * out again in the workflow module, and a second spelling of a condition is a
 * second condition: the screen showed the auditor their evidence while the gate
 * said there was none, which is the one refusal nobody can argue with because
 * they are looking at the thing it says is missing. One query, one answer, and
 * the gate and the panel cannot disagree again.
 */
export async function countAttachments(
  db: Client,
  organizationId: string,
  entityType: string,
  entityId: string,
): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM file_attachments fa
            JOIN files f ON f.${F.file_id} = fa.${FA.file_id}
           WHERE ${ATTACHED_TO}`,
    args: [organizationId, storedEntityType(entityType), entityId],
  });
  return Number(res.rows[0]?.n ?? 0);
}

export interface RecordAttachmentInput {
  /** The file id that also names the immutable storage key. */
  fileId: string;
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  /** The reference the storage backend returned once the bytes were stored. */
  ref: StoredObjectRef;
  /** The content hash computed on completion, for integrity. */
  contentHash: string;
  contentHashAlgo: string;
}

/**
 * Record the metadata for an already-stored object: a `files` row (with the
 * storage backend, immutable key and content hash) and a `file_attachments`
 * link. Called only after the object has been uploaded and verified, so evidence
 * is modelled end-to-end regardless of backend.
 */
export async function recordAttachment(
  db: Client,
  organizationId: string,
  input: RecordAttachmentInput,
): Promise<string> {
  const attachmentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const entityType = storedEntityType(input.entityType);
  const write = db.batch(
    [
      {
        sql: `INSERT INTO files
                (file_id, organization_id, file_name, mime_type, size_bytes,
                 storage_backend, storage_key, content_hash, content_hash_algo,
                 uploaded_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.fileId,
          organizationId,
          input.fileName,
          input.contentType,
          input.sizeBytes,
          input.ref.backend,
          input.ref.key,
          input.contentHash,
          input.contentHashAlgo,
          input.uploadedBy,
          now,
        ],
      },
      {
        sql: `INSERT INTO file_attachments
                (${FA.attachment_id}, ${FA.file_id}, ${FA.entity_type}, ${FA.entity_id},
                 ${FA.file_category}, ${FA.attached_by}, ${FA.attached_at})
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          attachmentId,
          input.fileId,
          entityType,
          input.entityId,
          EVIDENCE_CATEGORY,
          input.uploadedBy,
          now,
        ],
      },
    ],
    'write',
  );
  try {
    await write;
  } catch (err) {
    // The driver's own message, because "the evidence could not be stored" tells
    // an operator nothing about a column, a constraint or a type that refused.
    console.error(
      `${ATTACH_TAG} the write failed`,
      JSON.stringify({
        organization_id: organizationId,
        file_id: input.fileId,
        entity_type: entityType,
        entity_id: input.entityId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw err;
  }

  // The file row and the link row are one write, and the write is not finished
  // until the link is there (Build Prompt 65). `file_attachments` was empty
  // system-wide while `files` filled up, so every attachment was orphaned: the
  // bytes were in storage, the metadata was in the database, and nothing tied
  // either to the finding they belonged to. The evidence panel showed nothing,
  // the send-to-auditee gate correctly counted nothing, and the upload said it
  // had worked. A read-back is one cheap query, and it turns that silence into
  // a failure at the moment of attach.
  const linked = await db.execute({
    sql: `SELECT 1 FROM file_attachments
           WHERE ${FA.attachment_id} = ? AND ${FA.file_id} = ? AND ${SAME_ENTITY_TYPE}
             AND ${FA.entity_id} = ? LIMIT 1`,
    args: [attachmentId, input.fileId, entityType, input.entityId],
  });
  if (linked.rows.length === 0) {
    console.error(
      `${ATTACH_TAG} the link row was not written`,
      JSON.stringify({
        organization_id: organizationId,
        file_id: input.fileId,
        entity_type: entityType,
        entity_id: input.entityId,
        attachment_id: attachmentId,
      }),
    );
    throw new Error('The evidence was stored but could not be attached to the record.');
  }
  return attachmentId;
}

export interface AttachmentAccess {
  attachmentId: string;
  fileId: string;
  fileName: string;
  mimeType: string | null;
  backend: string;
  storageKey: string | null;
  driveFileId: string | null;
  entityType: string;
  entityId: string;
}

/**
 * Resolve one attachment to the file reference and the entity it hangs off,
 * scoped to the acting organisation, for the download and deletion paths. The
 * entity is what the RBAC and auditee-safe checks are run against.
 */
export async function getAttachmentForAccess(
  db: Client,
  organizationId: string,
  attachmentId: string,
): Promise<AttachmentAccess | null> {
  const res = await db.execute({
    sql: `SELECT fa.${FA.attachment_id} AS attachment_id, f.${F.file_id} AS file_id,
                 f.${F.file_name} AS file_name, f.${F.mime_type} AS mime_type,
                 f.${F.storage_backend} AS backend, f.${F.storage_key} AS storage_key,
                 f.${F.drive_file_id} AS drive_file_id, fa.${FA.entity_type} AS entity_type,
                 fa.${FA.entity_id} AS entity_id
            FROM file_attachments fa
            JOIN files f ON f.${F.file_id} = fa.${FA.file_id}
           WHERE f.${F.organization_id} = ? AND f.${F.deleted_at} IS NULL
             AND fa.${FA.attachment_id} = ?
           LIMIT 1`,
    args: [organizationId, attachmentId],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    attachmentId: String(r.attachment_id),
    fileId: String(r.file_id),
    fileName: String(r.file_name ?? ''),
    mimeType: r.mime_type == null ? null : String(r.mime_type),
    backend: String(r.backend ?? 'r2'),
    storageKey: r.storage_key == null ? null : String(r.storage_key),
    driveFileId: r.drive_file_id == null ? null : String(r.drive_file_id),
    entityType: String(r.entity_type ?? ''),
    entityId: String(r.entity_id ?? ''),
  };
}

/**
 * Bind evidence staged against a create-form draft token to the record the
 * save just created. Only rows the same user staged, on files inside the
 * acting organisation, move; anything else is untouched. Returns how many
 * attachments were bound.
 */
export async function bindDraftAttachments(
  db: Client,
  organizationId: string,
  userId: string,
  draftEntityType: 'work_paper_draft' | 'action_plan_draft',
  draftToken: string,
  entityType: 'work_paper' | 'action_plan',
  entityId: string,
): Promise<number> {
  if (draftToken.trim() === '') return 0;
  const res = await db.execute({
    sql: `UPDATE file_attachments
             SET ${FA.entity_type} = ?, ${FA.entity_id} = ?
           WHERE ${SAME_ENTITY_TYPE} AND ${FA.entity_id} = ? AND ${FA.attached_by} = ?
             AND ${FA.file_id} IN (SELECT ${F.file_id} FROM files
                                    WHERE ${F.organization_id} = ? AND ${F.deleted_at} IS NULL)`,
    args: [
      storedEntityType(entityType),
      entityId,
      storedEntityType(draftEntityType),
      draftToken.trim(),
      userId,
      organizationId,
    ],
  });
  return res.rowsAffected ?? 0;
}
