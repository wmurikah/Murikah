/**
 * Evidence metadata for work papers and their requirements, recorded through
 * `files` and `file_attachments`, scoped to the acting organisation. The bytes
 * live behind the storage interface (src/lib/grc/storage.ts), which is
 * deliberately not wired until the Google Drive vs R2 decision is made; this
 * module only reads and writes the metadata, so the detail can list evidence and
 * a chosen backend can be attached in one place later.
 */
import type { Client } from '@libsql/client/web';
import type { StoredObjectRef } from '@grc/storage';

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
    sql: `SELECT fa.attachment_id AS attachment_id, f.file_id AS file_id, f.file_name AS file_name,
                 f.mime_type AS mime_type, f.size_bytes AS size_bytes, f.storage_backend AS backend,
                 f.uploaded_by AS uploaded_by, f.created_at AS created_at
            FROM file_attachments fa
            JOIN files f ON f.file_id = fa.file_id
           WHERE fa.organization_id = ? AND fa.entity_type = ? AND fa.entity_id = ?
        ORDER BY f.created_at DESC`,
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
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  /** The reference returned by the storage backend once the bytes are stored. */
  ref: StoredObjectRef;
}

/**
 * Record the metadata for an already-stored object: a `files` row and a
 * `file_attachments` link. Called only after the storage backend has stored the
 * bytes (the backend is not wired in this prompt), so evidence is modelled
 * end-to-end without choosing the backend here.
 */
export async function recordAttachment(
  db: Client,
  organizationId: string,
  input: RecordAttachmentInput,
): Promise<string> {
  const fileId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO files
                (file_id, organization_id, file_name, mime_type, size_bytes,
                 storage_backend, storage_key, uploaded_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          fileId,
          organizationId,
          input.fileName,
          input.contentType,
          input.sizeBytes,
          input.ref.backend,
          input.ref.key,
          input.uploadedBy,
          now,
        ],
      },
      {
        sql: `INSERT INTO file_attachments
                (attachment_id, organization_id, file_id, entity_type, entity_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [attachmentId, organizationId, fileId, input.entityType, input.entityId, now],
      },
    ],
    'write',
  );
  return attachmentId;
}
