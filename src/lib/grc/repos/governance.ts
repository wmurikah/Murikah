/**
 * Evidence governance: legal holds, retention and the soft-deletion queue, plus
 * the migration worklist. Deletion is never a hard delete here: a request is
 * queued in `deletion_queue`, blocked outright when an active `legal_holds` row
 * covers the entity, and stamped with the earliest purge date the
 * `retention_policies` allow (the queue's own `hard_delete_after`), so the
 * deferred purge honours retention. Holds and queued deletions are written to
 * `audit_log` by the caller so the chain of custody is complete.
 *
 * Column names come from the typed schema layer. Three live-table facts shape
 * this module: `legal_holds` has no entity columns (coverage lives in its
 * `entity_filter`, evaluated by the pure holdRules matcher, failing closed on a
 * malformed filter); `retention_policies` is platform-wide by entity type, not
 * per organisation; and `deletion_queue` records the soft deletion itself
 * (`soft_deleted_at`, `hard_delete_after`, `processed_at`), keyed to the file
 * being removed.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { holdCovers } from './holdRules';

const LH = cols(C.legal_holds);
const RP = cols(C.retention_policies);
const DQ = cols(C.deletion_queue);
const F = cols(C.files);
const FA = cols(C.file_attachments);

interface ActiveHold {
  filter: string | null;
}

/** The active (unreleased) holds; a small reference set evaluated in memory. */
async function activeHolds(db: Client): Promise<ActiveHold[]> {
  const res = await db.execute({
    sql: `SELECT ${LH.entity_filter} AS entity_filter FROM legal_holds
           WHERE ${LH.released_at} IS NULL
           LIMIT 500`,
    args: [],
  });
  return res.rows.map((r) => ({
    filter: r.entity_filter == null ? null : String(r.entity_filter),
  }));
}

/** Whether an active (unreleased) legal hold covers the entity. */
export async function isUnderLegalHold(
  db: Client,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const holds = await activeHolds(db);
  return holds.some((h) => holdCovers(h.filter, entityType, entityId));
}

/**
 * The retention floor for an entity type: the ISO instant before which evidence
 * must not be purged, or null when no policy applies. Computed from the longest
 * matching policy's retention_days relative to the given now. Policies are
 * platform-wide reference data, keyed by entity type.
 */
export async function retentionFloor(
  db: Client,
  entityType: string,
  now: Date,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT MAX(${RP.retention_days}) AS days FROM retention_policies
           WHERE ${RP.entity_type} = ? AND (${RP.is_active} IS NULL OR ${RP.is_active} = 1)`,
    args: [entityType],
  });
  const days = res.rows[0]?.days;
  if (days == null) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(now.getTime() + n * 86_400_000).toISOString();
}

export interface QueueDeletionInput {
  /** The entity the evidence hangs off, kept in the reason for the trail. */
  entityType: string;
  entityId: string;
  fileId: string;
  requestedBy: string;
  reason: string;
  /** The retention floor: the object must not be purged before this instant. */
  retainUntil: string | null;
}

/**
 * Queue a soft deletion of one file. The row records when it was soft-deleted
 * and the earliest instant the deferred purge may remove it; processed_at stays
 * null until the purge runs.
 */
export async function queueDeletion(db: Client, input: QueueDeletionInput): Promise<string> {
  const queueId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO deletion_queue
            (${DQ.queue_id}, ${DQ.entity_type}, ${DQ.entity_id}, ${DQ.soft_deleted_at},
             ${DQ.hard_delete_after}, ${DQ.reason}, ${DQ.requested_by})
          VALUES (?, 'file', ?, ?, ?, ?, ?)`,
    args: [
      queueId,
      input.fileId,
      now,
      input.retainUntil,
      `${input.reason} (${input.entityType} ${input.entityId})`,
      input.requestedBy,
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
 * overdue refresh, not a tenant request. The hold check runs through the same
 * matcher the deletion path uses, so the two can never disagree.
 */
export async function listDriveFilesToMigrate(
  db: Client,
  limit: number,
): Promise<DriveFileToMigrate[]> {
  const [holds, res] = await Promise.all([
    activeHolds(db),
    db.execute({
      sql: `SELECT f.${F.file_id} AS file_id, f.${F.organization_id} AS organization_id,
                 f.${F.drive_file_id} AS drive_file_id, f.${F.file_name} AS file_name,
                 f.${F.mime_type} AS mime_type, fa.${FA.entity_type} AS entity_type,
                 fa.${FA.entity_id} AS entity_id
            FROM files f
            JOIN file_attachments fa ON fa.${FA.file_id} = f.${F.file_id}
           WHERE f.${F.storage_backend} = 'drive' AND f.${F.drive_file_id} IS NOT NULL
             AND f.${F.deleted_at} IS NULL
           LIMIT ?`,
      args: [limit],
    }),
  ]);
  return res.rows
    .map((r) => ({
      fileId: String(r.file_id),
      organizationId: String(r.organization_id),
      driveFileId: String(r.drive_file_id),
      fileName: String(r.file_name ?? ''),
      mimeType: r.mime_type == null ? null : String(r.mime_type),
      entityType: String(r.entity_type ?? ''),
      entityId: String(r.entity_id ?? ''),
    }))
    .filter((f) => !holds.some((h) => holdCovers(h.filter, f.entityType, f.entityId)));
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
              SET ${F.storage_backend} = 'r2', ${F.storage_key} = ?, ${F.content_hash} = ?,
                  ${F.content_hash_algo} = ?
            WHERE ${F.file_id} = ? AND ${F.organization_id} = ?`,
    args: [storageKey, contentHash, contentHashAlgo, fileId, organizationId],
  });
}
