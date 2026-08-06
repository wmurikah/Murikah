/**
 * Pure helpers for evidence object keys and content hashing. No imports (types
 * only), so node strips types and unit-tests this directly.
 *
 * Every object lives under a per-tenant prefix so tenants are isolated by key
 * namespace: org/{organization_id}/{entity}/{entity_id}/{file_id}/{safe_filename}.
 * A presigned URL is only ever issued for a key that begins with the acting
 * tenant's prefix, so a signed URL can never reach another tenant's evidence.
 */

/** The content-hash algorithm recorded on files.content_hash_algo. */
export const CONTENT_HASH_ALGO = 'sha256';

/** The maximum length of the filename segment kept in a key. */
const MAX_FILENAME = 120;

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Copy a view into a fresh ArrayBuffer, so Web Crypto sees an unambiguous BufferSource. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/**
 * Reduce a client filename to a safe key segment: drop any path, keep only
 * letters, digits, dot, underscore and hyphen, collapse the rest, and trim
 * leading and trailing separators. Never empty (defaults to 'file'), never a
 * traversal segment, and capped in length.
 */
export function safeFilename(name: string): string {
  const base = String(name).split(/[\\/]/).pop();
  const cleaned = (base ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, MAX_FILENAME);
  return cleaned === '' ? 'file' : cleaned;
}

/** The key prefix that isolates one tenant's evidence. */
export function orgPrefix(organizationId: string): string {
  return `org/${organizationId}/`;
}

export interface KeyParts {
  organizationId: string;
  entity: string;
  entityId: string;
  fileId: string;
  fileName: string;
}

/**
 * The tenant-scoped, immutable object key for one evidence file. The file_id
 * makes the key unique, so a replacement is a new file_id and a new key, never
 * an overwrite of an existing object.
 */
export function buildObjectKey(parts: KeyParts): string {
  return (
    orgPrefix(parts.organizationId) +
    `${parts.entity}/${parts.entityId}/${parts.fileId}/${safeFilename(parts.fileName)}`
  );
}

/** Whether a key sits inside the tenant's prefix. Guards every presign. */
export function keyBelongsToOrg(key: string, organizationId: string): boolean {
  return typeof key === 'string' && key.startsWith(orgPrefix(organizationId));
}

/**
 * The deterministic key of a file's optimised copy (Build Prompt 32): the
 * original key with `opt/` inserted directly after the tenant prefix, so the
 * copy stays inside the same tenant namespace and every presign guard applies
 * to it unchanged. The live files table records the original key; the
 * optimised key is always derived from it by this one function, never stored,
 * so the pair can never disagree. Null when the key is not tenant-scoped.
 */
export function optimisedKey(key: string, organizationId: string): string | null {
  const prefix = orgPrefix(organizationId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (rest.startsWith('opt/')) return null;
  return `${prefix}opt/${rest}`;
}

/** The lower-case hex sha256 of the given bytes, for files.content_hash. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(view));
  return toHex(digest);
}
