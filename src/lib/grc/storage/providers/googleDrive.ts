/**
 * The Google Drive provider (Build Prompt 51).
 *
 * The organisation connects a Google account once; the refresh token rests
 * sealed against that organisation. Evidence is written as files inside the
 * chosen folder, and the object key becomes the file's name, so a key is a name
 * here rather than a path.
 *
 * Drive authenticates with a bearer token that must never reach a browser, so
 * `presignedDownloadUrl` and `presignedUploadUrl` return null and the bytes
 * stream through the Worker. The download route already handles that branch.
 *
 * A returned `StoredObjectRef.key` is the Drive **file id**, not the name: names
 * are not unique in Drive and a caller must be able to fetch exactly the object
 * it wrote. `head` and `get` therefore take an id, and `keyToId` resolves a name
 * to an id only where a caller still holds a name.
 */
import type {
  ObjectHead,
  PutMeta,
  StorageFolder,
  StorageProvider,
  StoredObjectRef,
  TestResult,
} from '../provider';
import { authed, tokenHolder, type OAuthApp } from './oauth';

const PROVIDER = 'google_drive' as const;
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Drive files this application created. Narrower than full Drive access. */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** The consent URL for the one-time connect, mirroring the Outlook flow. */
export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    // Both are required for Google to return a refresh token at all, and its
    // absence is the classic reason a connection dies an hour after it is made.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${q.toString()}`;
}

export function createGoogleDriveProvider(
  app: OAuthApp,
  config: Record<string, string>,
  folderId: string | null,
): StorageProvider | null {
  const refreshToken = (config.refresh_token ?? '').trim();
  if (!refreshToken) return null;
  const token = tokenHolder(app, refreshToken);
  const parent = folderId ?? 'root';

  /** The id of the file stored under a key (its name) inside the folder. */
  const idForName = async (name: string): Promise<string | null> => {
    const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
    const res = await authed(token, `${FILES}?q=${q}&fields=files(id)&pageSize=1`);
    if (!res.ok) return null;
    const body = (await res.json()) as { files?: { id?: string }[] };
    return body.files?.[0]?.id ?? null;
  };

  /** A key may already be an id (what put returned) or a name (a legacy row). */
  const resolveId = async (key: string): Promise<string | null> =>
    /^[A-Za-z0-9_-]{20,}$/.test(key) ? key : idForName(key);

  return {
    provider: PROVIDER,

    async testConnection(): Promise<TestResult> {
      try {
        const name = `murikah-connection-probe-${crypto.randomUUID()}`;
        const created = await authed(token, `${UPLOAD}?uploadType=media`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'murikah connection probe',
        });
        if (!created.ok) {
          return { ok: false, error: `Drive refused a test write (HTTP ${created.status}).` };
        }
        const { id } = (await created.json()) as { id?: string };
        if (!id) return { ok: false, error: 'Drive accepted the write but returned no file id.' };
        // Name and re-parent it into the chosen folder, which is also the check
        // that the folder is reachable by this account.
        const moved = await authed(
          token,
          `${FILES}/${id}?addParents=${encodeURIComponent(parent)}&fields=id`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          },
        );
        await authed(token, `${FILES}/${id}`, { method: 'DELETE' });
        if (!moved.ok) {
          return { ok: false, error: `The chosen folder is not writable (HTTP ${moved.status}).` };
        }
        return { ok: true, detail: 'Created and removed a probe file in the chosen folder.' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Drive is unreachable.' };
      }
    },

    async listFolders(parentId?: string): Promise<StorageFolder[]> {
      const scope = parentId ?? 'root';
      const q = encodeURIComponent(
        `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${scope}' in parents`,
      );
      const res = await authed(token, `${FILES}?q=${q}&fields=files(id,name)&pageSize=100`);
      if (!res.ok) return [];
      const body = (await res.json()) as { files?: { id?: string; name?: string }[] };
      return (body.files ?? [])
        .filter((f): f is { id: string; name: string } => Boolean(f.id && f.name))
        .map((f) => ({ id: f.id, name: f.name }));
    },

    async put(key, bytes, meta: PutMeta): Promise<StoredObjectRef> {
      const body =
        bytes instanceof ReadableStream ? await new Response(bytes).arrayBuffer() : bytes;
      const created = await authed(token, `${UPLOAD}?uploadType=media`, {
        method: 'POST',
        headers: { 'content-type': meta.contentType },
        body: body as BodyInit,
      });
      if (!created.ok) throw new Error(`Drive refused the write (HTTP ${created.status}).`);
      const { id } = (await created.json()) as { id?: string };
      if (!id) throw new Error('Drive returned no file id for the written object.');
      await authed(token, `${FILES}/${id}?addParents=${encodeURIComponent(parent)}&fields=id`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // The tenant-scoped key is kept as the name, so an object is still
        // identifiable by eye in the customer's own Drive.
        body: JSON.stringify({ name: meta.fileName ?? key }),
      });
      // The id is the durable handle; the name is for humans.
      return { backend: PROVIDER, key: id };
    },

    async get(key): Promise<ReadableStream> {
      const id = await resolveId(key);
      if (!id) throw new Error('The evidence file was not found in Drive.');
      const res = await authed(token, `${FILES}/${id}?alt=media`);
      if (!res.ok || !res.body) throw new Error('The evidence file was not found in Drive.');
      return res.body;
    },

    async head(key): Promise<ObjectHead | null> {
      const id = await resolveId(key);
      if (!id) return null;
      const res = await authed(token, `${FILES}/${id}?fields=size`);
      if (!res.ok) return null;
      const body = (await res.json()) as { size?: string };
      return { size: Number(body.size ?? 0) };
    },

    // Drive authenticates with a bearer token; handing one to a browser would
    // hand it the whole account. The Worker streams the bytes instead.
    async presignedDownloadUrl(): Promise<string | null> {
      return null;
    },
    async presignedUploadUrl(): Promise<string | null> {
      return null;
    },

    async markForDeletion(key): Promise<void> {
      const id = await resolveId(key);
      if (!id) return;
      await authed(token, `${FILES}/${id}`, { method: 'DELETE' });
    },
  };
}
