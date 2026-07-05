/**
 * Evidence storage seam. The decision recorded in grc/docs/evidence-storage.md
 * is taken: new evidence is stored in Cloudflare R2, and existing Google Drive
 * files are read through the same seam until a background job migrates them.
 *
 * App code depends only on this module: the types, and the operations below.
 * Only the backend implementations (storage/r2.ts, storage/drive.ts) know the
 * backend, and only they read credentials from the Worker env. New uploads and
 * downloads use presigned URLs so the large bytes never stream through the
 * Worker; the content hash is computed once, server-side, on completion.
 */
import type { StoredObjectRef, PutInput, StorageBackend } from './storage/types';
import { getR2Backend } from './storage/r2';
import { getDriveBackend } from './storage/drive';
import { sha256Hex, CONTENT_HASH_ALGO } from './storage/keys';

export type { StoredObjectRef, PutInput, StoredObjectHead, StorageBackend } from './storage/types';

const R2 = 'r2';
const DRIVE = 'drive';

/** The active write backend (R2). New evidence is always written here. */
export function getStorageBackend(): StorageBackend {
  const r2 = getR2Backend();
  if (!r2) {
    throw new Error('Evidence storage (Cloudflare R2) is not configured on this worker.');
  }
  return r2;
}

/** Whether the write backend (R2) is configured; false leaves evidence inert. */
export function storageConfigured(): boolean {
  return getR2Backend() != null;
}

/** Whether the Drive read-through credential is configured. */
export function driveConfigured(): boolean {
  return getDriveBackend() != null;
}

/** Resolve the backend that holds a given object, by its recorded backend name. */
export function backendFor(ref: StoredObjectRef): StorageBackend {
  if (ref.backend === DRIVE) {
    const drive = getDriveBackend();
    if (!drive) throw new Error('Google Drive read-through is not configured on this worker.');
    return drive;
  }
  return getStorageBackend();
}

/** A presigned PUT URL for a tenant-scoped key (R2). The caller has RBAC-checked. */
export async function presignUpload(key: string, expiresInSeconds: number): Promise<string> {
  return getStorageBackend().presignPut(key, expiresInSeconds);
}

export interface FinalisedObject {
  size: number;
  hash: string;
  algo: string;
}

/**
 * After a presigned upload completes, confirm the object exists and compute its
 * content hash server-side. Returns null when the object is absent (the upload
 * did not complete), so the caller records nothing.
 */
export async function finaliseUpload(ref: StoredObjectRef): Promise<FinalisedObject | null> {
  const backend = backendFor(ref);
  const head = await backend.head(ref);
  if (!head) return null;
  const stream = await backend.get(ref);
  const buffer = await new Response(stream).arrayBuffer();
  const hash = await sha256Hex(buffer);
  return { size: head.size || buffer.byteLength, hash, algo: CONTENT_HASH_ALGO };
}

/**
 * Resolve how to download a stored object. R2 objects get a short-lived presigned
 * GET URL (the client fetches R2 directly); Drive objects are read through the
 * worker, so the caller streams the returned body instead.
 */
export type DownloadPlan =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; body: ReadableStream };

export async function planDownload(
  ref: StoredObjectRef,
  expiresInSeconds: number,
): Promise<DownloadPlan> {
  if (ref.backend === R2) {
    return { kind: 'redirect', url: await getStorageBackend().presignGet(ref, expiresInSeconds) };
  }
  return { kind: 'stream', body: await backendFor(ref).get(ref) };
}

/** Read an object's bytes as a stream, routing by backend (used by migration). */
export async function openObject(ref: StoredObjectRef): Promise<ReadableStream> {
  return backendFor(ref).get(ref);
}

/** Write bytes to R2 at a tenant-scoped key (used server-side by migration). */
export async function putObject(input: PutInput): Promise<StoredObjectRef> {
  return getStorageBackend().put(input);
}

/** Hard-remove an object. Only ever called by the governed deletion path. */
export async function removeObject(ref: StoredObjectRef): Promise<void> {
  await backendFor(ref).remove(ref);
}
