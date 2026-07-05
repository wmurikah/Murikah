/**
 * Background migration of Drive-backed evidence to R2. For each eligible file
 * (its entity not under an active legal hold), it reads the bytes from Drive
 * through the seam, computes the content hash, writes the object to the tenant R2
 * key, and switches files.storage_backend to 'r2' with the new key and hash,
 * leaving drive_file_id for provenance. It runs in batches from the worker's
 * scheduled() handler and never blocks an upload or download; each file is
 * best-effort, so one failure does not stop the batch.
 */
import type { Client } from '@libsql/client/web';
import { listDriveFilesToMigrate, markMigratedToR2 } from '../repos/governance';
import { openObject, putObject, storageConfigured, driveConfigured } from '../storage';
import { buildObjectKey, sha256Hex, CONTENT_HASH_ALGO } from './keys';

export interface MigrationResult {
  attempted: number;
  migrated: number;
  failed: number;
}

/** Migrate up to `limit` Drive-backed files to R2. Returns a small summary. */
export async function runEvidenceMigration(db: Client, limit: number): Promise<MigrationResult> {
  // Nothing to do until both the R2 write backend and the Drive read credential
  // are configured; leaving either absent keeps the app fully working.
  if (!storageConfigured() || !driveConfigured()) {
    return { attempted: 0, migrated: 0, failed: 0 };
  }

  const files = await listDriveFilesToMigrate(db, limit);
  let migrated = 0;
  let failed = 0;

  for (const f of files) {
    try {
      const stream = await openObject({ backend: 'drive', key: f.driveFileId });
      const buffer = await new Response(stream).arrayBuffer();
      const hash = await sha256Hex(buffer);
      const key = buildObjectKey({
        organizationId: f.organizationId,
        entity: f.entityType,
        entityId: f.entityId,
        fileId: f.fileId,
        fileName: f.fileName,
      });
      await putObject({
        key,
        contentType: f.mimeType ?? 'application/octet-stream',
        body: buffer,
      });
      await markMigratedToR2(db, f.organizationId, f.fileId, key, hash, CONTENT_HASH_ALGO);
      migrated += 1;
    } catch {
      failed += 1;
    }
  }

  return { attempted: files.length, migrated, failed };
}
