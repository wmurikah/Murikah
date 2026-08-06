/**
 * Storage-side environment, read from the Cloudflare Worker env. Nothing throws
 * when missing: an absent bucket binding or absent credentials simply mean that
 * backend is unconfigured, so the seam reports "storage not configured" and the
 * rest of the app is unaffected (the same graceful pattern as notify/env.ts).
 * Secrets are Worker secrets or .dev.vars, never committed.
 */
import { env } from 'cloudflare:workers';

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The R2 bucket binding for head/get/put/delete, or null when unbound. */
export function getR2Bucket(): R2Bucket | null {
  return env.EVIDENCE_BUCKET ?? null;
}

export interface R2PresignConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** The S3 credentials for presigning R2 URLs, or null when any is missing. */
export function getR2PresignConfig(): R2PresignConfig | null {
  const accountId = nonEmpty(env.R2_ACCOUNT_ID);
  const accessKeyId = nonEmpty(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.R2_SECRET_ACCESS_KEY);
  const bucket = nonEmpty(env.R2_BUCKET);
  if (accountId && accessKeyId && secretAccessKey && bucket) {
    return { accountId, accessKeyId, secretAccessKey, bucket };
  }
  return null;
}

export interface DriveMirrorConfig {
  /** The service account's email (the folder must be shared to it). */
  clientEmail: string;
  /** The service account's PKCS#8 private key, PEM as issued by Google. */
  privateKeyPem: string;
  /** The Drive folder the optimised copies are mirrored into. */
  folderId: string;
}

/**
 * The Drive mirror credential (Build Prompt 32): a service-account key JSON in
 * GDRIVE_SERVICE_ACCOUNT_JSON plus the target folder in
 * GDRIVE_EVIDENCE_FOLDER_ID. Null when either is missing or the JSON is not a
 * service-account key, which simply leaves the mirror off.
 */
export function getDriveMirrorConfig(): DriveMirrorConfig | null {
  const raw = nonEmpty(env.GDRIVE_SERVICE_ACCOUNT_JSON);
  const folderId = nonEmpty(env.GDRIVE_EVIDENCE_FOLDER_ID);
  if (!raw || !folderId) return null;
  try {
    const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
    const clientEmail = nonEmpty(parsed.client_email);
    const privateKeyPem = nonEmpty(parsed.private_key);
    if (!clientEmail || !privateKeyPem) return null;
    return { clientEmail, privateKeyPem, folderId };
  } catch {
    return null;
  }
}

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** The read-only Google Drive credential, or null when any is missing. */
export function getDriveConfig(): DriveConfig | null {
  const clientId = nonEmpty(env.GDRIVE_CLIENT_ID);
  const clientSecret = nonEmpty(env.GDRIVE_CLIENT_SECRET);
  const refreshToken = nonEmpty(env.GDRIVE_REFRESH_TOKEN);
  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken };
  }
  return null;
}
