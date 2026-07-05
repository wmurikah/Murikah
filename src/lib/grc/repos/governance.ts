/**
 * Evidence governance: legal holds, retention and the soft-deletion queue, plus
 * the migration worklist. Deletion is never a hard delete here: a request is
 * queued in `deletion_queue`, blocked outright when a `legal_holds` row covers
 * the entity, and stamped with the earliest purge date that `retention_policies`
 * allow, so the deferred purge honours retention. Holds and queued deletions are
 * written to `audit_log` by the caller so the chain of custody is complete.
 *
 * Column names follow grc/docs/schema-assumptions.md; a held entity failing the
 * hold check safe (blocked) is deliberate.
 */
import type { Client } from '@libsql/client/web';

/** Whether an active (unreleased) legal hold covers the entity. */
export async function isUnderLegalHold(
  db: Client,
  organizationId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM legal_holds
           WHERE organization_id = ? AND entity_type = ? AND entity_id = ?
             AND released_at IS NULL
           LIMIT 1`,
    args: [organizationId, entityType, entityId],
  });
  return res.rows.length > 0;
}

/**
 * The retention floor for an entity type: the ISO instant before which evidence
 * must not be purged, or null when no policy applies. Computed from the longest
 * matching policy's retention_days relative to the given now.
 */
export async function retentionFloor(
  db: Client,
  organizationId: string,
  entityType: string,
  now: Date,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT MAX(retention_days) AS days FROM retention_policies
           WHERE organization_id = ? AND entity_type = ?`,
    args: [organizationId, entityType],
  });
  const days = res.rows[0]?.days;
  if (days == null) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(now.getTime() + n * 86_400_000).toISOString();
}

export interface QueueDeletionInput {
  entityType: string;
  entityId: string;
  fileId: string;
  requestedBy: string;
  reason: string;
  /** The retention floor: the object must not be purged before this instant. */
  retainUntil: string | null;
}

/** Queue a soft deletion. The row is PENDING; the actual purge is deferred and governed. */
export async function queueDeletion(
  db: Client,
  organizationId: string,
  input: QueueDeletionInput,
): Promise<string> {
  const queueId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO deletion_queue
            (queue_id, organization_id, entity_type, entity_id, file_id, requested_by,
             reason, status, retain_until, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    args: [
      queueId,
      organizationId,
      input.entityType,
      input.entityId,
      input.fileId,
      input.requestedBy,
      input.reason,
      input.retainUntil,
      new Date().toISOString(),
    ],
  });
  return queueId;
}

export interface DriveFileToMigrate {
  fileId: string;
  organizationId: string;
  driveFileId: string;
  fileName: string;
  mimeType: string | null;
  entityType: string;
  entityId: string;
}

/**
 * Drive-backed files eligible for migration to R2: those whose entity is not
 * under an active legal hold. A system-wide maintenance query across every
 * organisation (each file stays keyed by its own organization_id), like the
 * overdue refresh, not a tenant request.
 */
export async function listDriveFilesToMigrate(
  db: Client,
  limit: number,
): Promise<DriveFileToMigrate[]> {
  const res = await db.execute({
    sql: `SELECT f.file_id AS file_id, f.organization_id AS organization_id,
                 f.drive_file_id AS drive_file_id, f.file_name AS file_name,
                 f.mime_type AS mime_type, fa.entity_type AS entity_type, fa.entity_id AS entity_id
            FROM files f
            JOIN file_attachments fa
              ON fa.file_id = f.file_id AND fa.organization_id = f.organization_id
           WHERE f.storage_backend = 'drive' AND f.drive_file_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM legal_holds lh
                WHERE lh.organization_id = f.organization_id
                  AND lh.entity_type = fa.entity_type AND lh.entity_id = fa.entity_id
                  AND lh.released_at IS NULL)
           LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => ({
    fileId: String(r.file_id),
    organizationId: String(r.organization_id),
    driveFileId: String(r.drive_file_id),
    fileName: String(r.file_name ?? ''),
    mimeType: r.mime_type == null ? null : String(r.mime_type),
    entityType: String(r.entity_type ?? ''),
    entityId: String(r.entity_id ?? ''),
  }));
}

/**
 * Switch a migrated file to R2: record the new backend, key and content hash,
 * leaving drive_file_id untouched for provenance. Scoped by organization_id.
 */
export async function markMigratedToR2(
  db: Client,
  organizationId: string,
  fileId: string,
  storageKey: string,
  contentHash: string,
  contentHashAlgo: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE files
              SET storage_backend = 'r2', storage_key = ?, content_hash = ?, content_hash_algo = ?
            WHERE file_id = ? AND organization_id = ?`,
    args: [storageKey, contentHash, contentHashAlgo, fileId, organizationId],
  });
}
