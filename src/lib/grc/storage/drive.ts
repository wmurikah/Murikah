/**
 * The Google Drive read-through backend, for existing evidence stored under
 * files.drive_file_id. It reads and heads only; it never writes, so put, remove
 * and the presign methods refuse. An access token is obtained from a read-only
 * OAuth2 refresh-token flow (scope drive.readonly) and cached for the isolate,
 * the same shape as the Outlook Graph path. The credential is a Worker secret.
 */
import type { StorageBackend, StoredObjectRef, StoredObjectHead } from './types';
import { getDriveConfig, type DriveConfig } from './env';

const NAME = 'drive';
const NO_WRITE = 'Google Drive is read-only here; new evidence is stored in R2.';

interface CachedToken {
  token: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

async function getAccessToken(cfg: DriveConfig, now: number): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) return null;
  tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function bearer(cfg: DriveConfig): Promise<string> {
  const token = await getAccessToken(cfg, Date.now());
  if (!token) throw new Error('Could not obtain a Google Drive access token.');
  return token;
}

/** The Drive read-through backend, or null when the credential is absent. */
export function getDriveBackend(): StorageBackend | null {
  const cfg = getDriveConfig();
  if (!cfg) return null;

  return {
    name: NAME,
    async get(ref: StoredObjectRef): Promise<ReadableStream> {
      const token = await bearer(cfg);
      const id = encodeURIComponent(ref.key);
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok || !res.body) throw new Error(`Drive download failed (${res.status}).`);
      return res.body;
    },
    async head(ref: StoredObjectRef): Promise<StoredObjectHead | null> {
      const token = await bearer(cfg);
      const id = encodeURIComponent(ref.key);
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?fields=size&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { size?: string };
      return { size: json.size ? Number(json.size) : 0 };
    },
    async put(): Promise<StoredObjectRef> {
      throw new Error(NO_WRITE);
    },
    async remove(): Promise<void> {
      throw new Error(NO_WRITE);
    },
    async presignPut(): Promise<string> {
      throw new Error(NO_WRITE);
    },
    async presignGet(): Promise<string> {
      throw new Error('Google Drive files are downloaded through the worker, not presigned.');
    },
  };
}

/** Reset the cached token (used by tests and after a credential change). */
export function resetDriveTokenCache(): void {
  tokenCache = null;
}
