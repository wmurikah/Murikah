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
           WHERE f.${F.organization_id} = ? AND f.${F.deleted_at} IS NULL
             AND fa.${FA.entity_type} = ? AND fa.${FA.entity_id} = ?
        ORDER BY f.${F.created_at} DESC`,
    args: [organizationId, entityType, entityId],
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
  await db.batch(
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
          input.entityType,
          input.entityId,
          'EVIDENCE',
          input.uploadedBy,
          now,
        ],
      },
    ],
    'write',
  );
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
