/**
 * Evidence storage seam.
 *
 * Every operation is scoped to an organisation (Build Prompt 51). An
 * organisation configures its own provider under Settings → Evidence storage,
 * and the bytes go to that customer's own R2 bucket, Google Drive, SharePoint
 * or Dropbox. App code above this module depends only on the types and the
 * functions below; it never learns which provider answered.
 *
 * Two older shapes are deliberately still reachable, because evidence that is
 * already stored must stay readable:
 *
 * - `backend: 'drive'` rows predate the connector entirely and are read through
 *   the platform's read-only Drive credential.
 * - `backend: 'r2'` rows written before an organisation configured a connector
 *   live in the platform's own bucket, and fall back to it when the
 *   organisation has no R2 connection of its own.
 *
 * A stored reference is therefore always resolved by the backend it records,
 * never by whichever provider happens to be active now: an organisation that
 * switches from R2 to Dropbox can still download everything it attached before.
 */
import type { Client } from '@libsql/client/web';
import type { StoredObjectRef, PutInput, StorageBackend } from './storage/types';
import type { StorageProvider } from './storage/provider';
import { getR2Backend } from './storage/r2';
import { getDriveBackend } from './storage/drive';
import { sha256Hex, CONTENT_HASH_ALGO } from './storage/keys';
import { resolveProvider, resolveProviderForBackend } from './storage/resolve';
import { getGrcEnv } from './env';
import { getDb } from './db';

export type { StoredObjectRef, PutInput, StoredObjectHead, StorageBackend } from './storage/types';

const R2 = 'r2';
const DRIVE = 'drive';

/**
 * The narrow read/write surface the seam needs. `StorageProvider` satisfies it
 * structurally, and the two legacy backends are adapted onto it, so one code
 * path serves a connector and a legacy object alike.
 */
interface StoragePort {
  get(key: string): Promise<ReadableStream>;
  head(key: string): Promise<{ size: number } | null>;
  presignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string | null>;
  markForDeletion(key: string): Promise<void>;
}

/** Adapt a legacy env-configured backend onto the port. */
function legacyPort(backend: StorageBackend, name: string): StoragePort {
  return {
    get: (key) => backend.get({ backend: name, key }),
    head: (key) => backend.head({ backend: name, key }),
    presignedDownloadUrl: (key, ttl) =>
      name === R2 ? backend.presignGet({ backend: name, key }, ttl) : Promise.resolve(null),
    markForDeletion: (key) => backend.remove({ backend: name, key }),
  };
}

/** The platform's own R2 backend, still used by the legacy Drive migration. */
export function legacyStorageConfigured(): boolean {
  return getR2Backend() != null;
}

/** Whether the Drive read-through credential is configured. */
export function driveConfigured(): boolean {
  return getDriveBackend() != null;
}

/**
 * The acting organisation's active provider, or null when it has not configured
 * one. Callers that only need a yes or no use `storageConfiguredFor`.
 */
export async function orgProvider(
  db: Client,
  organizationId: string,
): Promise<StorageProvider | null> {
  return resolveProvider(db, getGrcEnv().sessionSecret, organizationId);
}

/**
 * Whether this organisation can store evidence right now. The create and detail
 * screens ask this to decide between the upload control and the honest "not
 * configured" message, so it opens its own database handle rather than making
 * every page thread one through.
 */
export async function storageConfiguredFor(organizationId: string): Promise<boolean> {
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    return (await resolveProvider(db, env.sessionSecret, organizationId)) !== null;
  } catch {
    // An unreachable database is not a reason to claim storage is ready; the
    // panel shows the same "not configured" message it would otherwise.
    return false;
  }
}

/**
 * Resolve the port that holds a stored reference, by the backend it records.
 *
 * The organisation's own connection for that backend wins; a legacy object
 * falls back to the platform's Drive credential or bucket. Null means the bytes
 * are unreachable, which the download route reports rather than hiding.
 */
async function portFor(
  db: Client,
  organizationId: string,
  ref: StoredObjectRef,
): Promise<StoragePort | null> {
  if (ref.backend === DRIVE) {
    const drive = getDriveBackend();
    return drive ? legacyPort(drive, DRIVE) : null;
  }
  const own = await resolveProviderForBackend(
    db,
    getGrcEnv().sessionSecret,
    organizationId,
    ref.backend,
  );
  if (own) return own;
  if (ref.backend === R2) {
    const r2 = getR2Backend();
    if (r2) return legacyPort(r2, R2);
  }
  return null;
}

export interface FinalisedObject {
  size: number;
  hash: string;
  algo: string;
}

/**
 * After an upload completes, confirm the object exists and compute its content
 * hash server-side. Returns null when the object is absent (the upload did not
 * complete), so the caller records nothing.
 */
export async function finaliseUpload(
  provider: StorageProvider,
  key: string,
): Promise<FinalisedObject | null> {
  const head = await provider.head(key);
  if (!head) return null;
  const stream = await provider.get(key);
  const buffer = await new Response(stream).arrayBuffer();
  const hash = await sha256Hex(buffer);
  return { size: head.size || buffer.byteLength, hash, algo: CONTENT_HASH_ALGO };
}

/**
 * Resolve how to download a stored object. A provider that can sign a URL (R2)
 * hands one back and the bytes flow straight to the client; the token-bearing
 * providers stream through the Worker instead, because handing a browser their
 * bearer token would hand it the whole account.
 */
export type DownloadPlan =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; body: ReadableStream };

export async function planDownload(
  db: Client,
  organizationId: string,
  ref: StoredObjectRef,
  expiresInSeconds: number,
): Promise<DownloadPlan> {
  const port = await portFor(db, organizationId, ref);
  if (!port) throw new Error(`No storage provider holds ${ref.backend} objects for this account.`);
  const url = await port.presignedDownloadUrl(ref.key, expiresInSeconds);
  if (url) return { kind: 'redirect', url };
  return { kind: 'stream', body: await port.get(ref.key) };
}

/** Read an object's bytes as a stream, routing by the backend it records. */
export async function openObject(
  db: Client,
  organizationId: string,
  ref: StoredObjectRef,
): Promise<ReadableStream> {
  const port = await portFor(db, organizationId, ref);
  if (!port) throw new Error(`No storage provider holds ${ref.backend} objects for this account.`);
  return port.get(ref.key);
}

/** Hard-remove an object. Only ever called by the governed deletion path. */
export async function removeObject(
  db: Client,
  organizationId: string,
  ref: StoredObjectRef,
): Promise<void> {
  const port = await portFor(db, organizationId, ref);
  if (port) await port.markForDeletion(ref.key);
}

/**
 * The legacy platform backends, for the Drive-to-R2 migration alone. That job
 * moves evidence that predates the connectors out of Google Drive and into the
 * platform's own bucket; it is not the per-organisation path and deliberately
 * does not resolve a connector.
 */
export function legacyBackend(name: string): StorageBackend {
  if (name === DRIVE) {
    const drive = getDriveBackend();
    if (!drive) throw new Error('Google Drive read-through is not configured on this worker.');
    return drive;
  }
  const r2 = getR2Backend();
  if (!r2) throw new Error('The platform evidence bucket is not configured on this worker.');
  return r2;
}

/** Write bytes to the platform bucket at a tenant-scoped key (migration only). */
export async function putLegacyObject(input: PutInput): Promise<StoredObjectRef> {
  return legacyBackend(R2).put(input);
}
