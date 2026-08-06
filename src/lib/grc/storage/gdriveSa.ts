/**
 * A minimal Google Drive client for the browse mirror (Build Prompt 32),
 * authenticated as a service account: an RS256-signed JWT (WebCrypto, no
 * library) is exchanged for a short-lived access token, cached for the
 * isolate, and files are uploaded into the shared folder with a multipart
 * request. Uploads are idempotent by name: an existing file with the same
 * deterministic name in the folder is reused rather than duplicated, so a
 * retried mirror never litters the folder. The key JSON only ever comes from
 * the Worker env (storage/env.ts), never the repository.
 */
import type { DriveMirrorConfig } from './env';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// The full Drive scope: the service account can still only see what is
// explicitly shared to it, and the narrower drive.file scope refuses uploads
// into some shared folders.
const SCOPE = 'https://www.googleapis.com/auth/drive';

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;

/** Drop the cached access token (tests, and after a credential change). */
export function resetDriveTokenCache(): void {
  tokenCache = null;
}

/** A service-account access token, cached for the isolate until near expiry. */
export async function getDriveAccessToken(cfg: DriveMirrorConfig): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const iat = Math.floor(now / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = b64urlJson({
    iss: cfg.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  });
  const signingInput = `${header}.${claims}`;

  let signature: ArrayBuffer;
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(cfg.privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    );
  } catch (err) {
    console.error('[grc.evidence.mirror] service-account key unusable:', String(err));
    return null;
  }

  const assertion = `${signingInput}.${b64url(new Uint8Array(signature))}`;
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    console.error('[grc.evidence.mirror] token exchange refused:', res.status);
    return null;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  tokenCache = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

/** The id of an existing file with this exact name in the folder, or null. */
async function findByName(token: string, folderId: string, name: string): Promise<string | null> {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
  const url =
    'https://www.googleapis.com/drive/v3/files?' +
    new URLSearchParams({
      q,
      fields: 'files(id)',
      pageSize: '1',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    }).toString();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { files?: { id?: string }[] };
  const id = body.files?.[0]?.id;
  return id ? String(id) : null;
}

/**
 * Upload bytes into the mirror folder under the deterministic name, reusing
 * an existing file of that name. Returns the Drive file id, or null on any
 * refusal (the caller leaves the row unmirrored and a later run retries).
 */
export async function uploadToDrive(
  cfg: DriveMirrorConfig,
  name: string,
  mimeType: string,
  bytes: ArrayBuffer,
): Promise<string | null> {
  const token = await getDriveAccessToken(cfg);
  if (!token) return null;

  const existing = await findByName(token, cfg.folderId, name).catch(() => null);
  if (existing) return existing;

  const boundary = `grc-mirror-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: [cfg.folderId] });
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const payload = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
  payload.set(head, 0);
  payload.set(new Uint8Array(bytes), head.byteLength);
  payload.set(tail, head.byteLength + bytes.byteLength);

  let res: Response;
  try {
    res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body: payload,
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[grc.evidence.mirror] Drive upload refused:', res.status, text.slice(0, 200));
    return null;
  }
  const body = (await res.json()) as { id?: string };
  return body.id ? String(body.id) : null;
}
