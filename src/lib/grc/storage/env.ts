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

/**
 * The platform's OAuth application registrations for the storage providers
 * (Build Prompt 51).
 *
 * These identify Murikah to Google, Microsoft and Dropbox and are the same for
 * every customer, so they are Worker secrets rather than per-organisation
 * settings. What is per-organisation, and sealed in `storage_connections`, is
 * the refresh token naming the customer's own account.
 *
 * Absent credentials mean that provider cannot be connected: the settings screen
 * says so plainly rather than offering a Connect button that would fail at the
 * consent screen. Registration is documented in `grc/docs/storage-setup.md`.
 */
export interface StorageOAuthApp {
  clientId: string;
  clientSecret: string;
}

function appFrom(id: unknown, secret: unknown): StorageOAuthApp | null {
  const clientId = nonEmpty(id);
  const clientSecret = nonEmpty(secret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The Google Cloud OAuth client used by the Drive connect flow. */
export function getGoogleStorageApp(): StorageOAuthApp | null {
  return appFrom(env.GDRIVE_CLIENT_ID, env.GDRIVE_CLIENT_SECRET);
}

/**
 * The Microsoft Entra app used by the SharePoint connect flow. It falls back to
 * the Outlook app's credentials, because a tenant that has already registered
 * one Entra application for this product can add the Files scopes to it rather
 * than registering a second.
 */
export function getMicrosoftStorageApp(): StorageOAuthApp | null {
  return (
    appFrom(env.SHAREPOINT_CLIENT_ID, env.SHAREPOINT_CLIENT_SECRET) ??
    appFrom(env.GRAPH_CLIENT_ID, env.GRAPH_CLIENT_SECRET)
  );
}

/** The Dropbox app used by the Dropbox connect flow. */
export function getDropboxApp(): StorageOAuthApp | null {
  return appFrom(env.DROPBOX_CLIENT_ID, env.DROPBOX_CLIENT_SECRET);
}
