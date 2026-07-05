/**
 * The evidence storage seam types, in one import-free module so both the public
 * seam (storage.ts) and each backend (r2.ts, drive.ts) share them without a cycle.
 *
 * App code depends only on these types and the functions the seam exports; only a
 * backend implementation knows whether the bytes live in R2 or Google Drive.
 */

export interface StoredObjectRef {
  /** The backend that holds the bytes: 'r2' or 'drive'. */
  backend: string;
  /** The backend-specific key: an R2 object key, or a Drive file id. */
  key: string;
}

export interface PutInput {
  /** The exact, tenant-scoped object key (built by the app, never by the backend). */
  key: string;
  contentType: string;
  body: ReadableStream | ArrayBuffer | Uint8Array;
}

export interface StoredObjectHead {
  size: number;
}

export interface StorageBackend {
  readonly name: string;
  /** Store bytes at a caller-provided key (used server-side, e.g. migration). */
  put(input: PutInput): Promise<StoredObjectRef>;
  /** Read the bytes for a reference (Drive read-through, migration source, fallback). */
  get(ref: StoredObjectRef): Promise<ReadableStream>;
  /** Confirm an object exists and return its size, or null when absent. */
  head(ref: StoredObjectRef): Promise<StoredObjectHead | null>;
  /** Remove the bytes for a reference (only ever called by the governed deletion path). */
  remove(ref: StoredObjectRef): Promise<void>;
  /** A short-lived presigned PUT URL for a key, for direct client upload. */
  presignPut(key: string, expiresInSeconds: number): Promise<string>;
  /** A short-lived presigned GET URL for a reference, for direct client download. */
  presignGet(ref: StoredObjectRef, expiresInSeconds: number): Promise<string>;
}
