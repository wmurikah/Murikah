/**
 * The Google Drive browse mirror (Build Prompt 32). R2 is the system of
 * record; this job copies the optimised copy (falling back to the original
 * when a file has none) into the shared Drive folder under the file's
 * deterministic name, and records the resulting Drive id on the files row
 * (the live drive_file_id column). It never runs in a request's critical
 * path: the upload endpoints only queue an attempt via waitUntil, and the
 * cron drain sweeps everything still unmirrored, so a failure simply retries
 * on the next run. A row is due when it is an R2 file with no drive_file_id;
 * legacy Drive-backed rows already carry their id and are never touched.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { getDriveMirrorConfig } from './env';
import { getR2Backend } from './r2';
import { optimisedKey } from './keys';
import { optimisedMime } from './derived';
import { uploadToDrive } from './gdriveSa';

const F = cols(C.files);
const TAG = '[grc.evidence.mirror]';

/** Whether the mirror is configured at all (used to skip quietly). */
export function mirrorConfigured(): boolean {
  return getDriveMirrorConfig() != null && getR2Backend() != null;
}

interface MirrorRow {
  fileId: string;
  organizationId: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
}

async function fetchDue(db: Client, limit: number, fileId?: string): Promise<MirrorRow[]> {
  const filter = fileId ? `AND ${F.file_id} = ?` : '';
  const res = await db.execute({
    sql: `SELECT ${F.file_id} AS file_id, ${F.organization_id} AS organization_id,
                 ${F.file_name} AS file_name, ${F.mime_type} AS mime_type,
                 ${F.storage_key} AS storage_key
            FROM files
           WHERE ${F.storage_backend} = 'r2' AND ${F.deleted_at} IS NULL
             AND (${F.drive_file_id} IS NULL OR ${F.drive_file_id} = '')
             AND ${F.storage_key} IS NOT NULL ${filter}
        ORDER BY ${F.created_at} ASC
           LIMIT ?`,
    args: fileId ? [fileId, limit] : [limit],
  });
  return res.rows.map((r) => ({
    fileId: String(r.file_id),
    organizationId: String(r.organization_id),
    fileName: String(r.file_name ?? 'file'),
    mimeType: String(r.mime_type ?? 'application/octet-stream'),
    storageKey: String(r.storage_key),
  }));
}

async function mirrorRow(db: Client, row: MirrorRow): Promise<boolean> {
  const cfg = getDriveMirrorConfig();
  const r2 = getR2Backend();
  if (!cfg || !r2) return false;

  // Prefer the optimised copy; the original is the fallback so every file
  // mirrors even before (or without) an optimised copy existing.
  let key = row.storageKey;
  let mime = row.mimeType;
  const opt = optimisedKey(row.storageKey, row.organizationId);
  if (opt && (await r2.head({ backend: 'r2', key: opt }))) {
    key = opt;
    mime = optimisedMime(row.mimeType);
  }

  const stream = await r2.get({ backend: 'r2', key });
  const bytes = await new Response(stream).arrayBuffer();
  const driveId = await uploadToDrive(cfg, row.fileName, mime, bytes);
  if (!driveId) return false;

  await db.execute({
    sql: `UPDATE files SET ${F.drive_file_id} = ?
           WHERE ${F.file_id} = ? AND ${F.organization_id} = ?`,
    args: [driveId, row.fileId, row.organizationId],
  });
  return true;
}

export interface MirrorSummary {
  scanned: number;
  mirrored: number;
  failed: number;
}

/** Sweep a batch of unmirrored files into the Drive folder (the cron drain). */
export async function runDriveMirror(db: Client, limit: number): Promise<MirrorSummary> {
  const summary: MirrorSummary = { scanned: 0, mirrored: 0, failed: 0 };
  if (!mirrorConfigured()) return summary;
  const due = await fetchDue(db, Math.max(1, Math.min(limit, 100)));
  summary.scanned = due.length;
  for (const row of due) {
    try {
      if (await mirrorRow(db, row)) summary.mirrored += 1;
      else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(TAG, 'mirror failed for', row.fileId, String(err));
    }
  }
  return summary;
}

/** Mirror one just-uploaded file, best-effort (queued via waitUntil). */
export async function mirrorFileSoon(db: Client, fileId: string): Promise<void> {
  try {
    if (!mirrorConfigured()) return;
    const due = await fetchDue(db, 1, fileId);
    if (due.length > 0) await mirrorRow(db, due[0]);
  } catch (err) {
    // The cron sweep retries; a prompt-mirror failure is only logged.
    console.error(TAG, 'prompt mirror failed for', fileId, String(err));
  }
}
