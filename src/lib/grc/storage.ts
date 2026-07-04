/**
 * Evidence storage backend, deliberately left as an interface only.
 *
 * DECISION REQUIRED (do not pick silently): the source stored evidence files in
 * Google Drive (files.drive_file_id). In the Cloudflare runtime the choice
 * between keeping Google Drive and moving to Cloudflare R2 affects every module
 * and the migration of existing files, so it must be decided deliberately, not
 * inferred here. See grc/docs/evidence-storage.md.
 *
 * This module defines the seam. The Work Papers module records attachment
 * metadata through files/file_attachments (repos/evidence.ts) and renders the
 * evidence UI, but no backend is wired: getStorageBackend throws until one is
 * chosen and implemented here, in this one place. No storage credentials are
 * read or committed.
 */

export interface StoredObjectRef {
  /** The backend that holds the bytes, e.g. 'drive' or 'r2'. */
  backend: string;
  /** The backend-specific key: a Drive file id, or an R2 object key. */
  key: string;
}

export interface PutInput {
  organizationId: string;
  fileName: string;
  contentType: string;
  body: ReadableStream | ArrayBuffer | Uint8Array;
}

export interface StorageBackend {
  readonly name: string;
  /** Store the bytes and return a reference to record against the file row. */
  put(input: PutInput): Promise<StoredObjectRef>;
  /** Fetch the bytes for a stored reference. */
  get(ref: StoredObjectRef): Promise<ReadableStream>;
  /** Remove the bytes for a stored reference. */
  remove(ref: StoredObjectRef): Promise<void>;
  /** A short-lived URL to download the object directly, if the backend supports one. */
  signedUrl?(ref: StoredObjectRef): Promise<string>;
}

/**
 * Resolve the configured storage backend. Throws until the Drive-or-R2 decision
 * is made and the chosen backend is implemented here. Callers that only record
 * or read metadata do not need this; only the actual upload and download do.
 */
export function getStorageBackend(): StorageBackend {
  // TODO(evidence-storage): implement the chosen backend (Google Drive or
  // Cloudflare R2) here, reading its credentials from cloudflare:workers env at
  // runtime, once the decision in grc/docs/evidence-storage.md is made.
  throw new Error(
    'Evidence storage backend is not configured yet. The Google Drive vs R2 decision is pending; see grc/docs/evidence-storage.md.',
  );
}
