/**
 * The Dropbox provider (Build Prompt 51).
 *
 * The organisation connects a Dropbox account once; the refresh token rests
 * sealed against that organisation. The chosen folder is a path, and an object
 * key becomes a path beneath it, so a stored reference reads as a path a person
 * can find in the customer's own Dropbox.
 *
 * Dropbox authenticates with a bearer token, so no presigned URL is issued and
 * the bytes stream through the Worker. Its API is unusual in two ways this
 * module has to absorb: the arguments to a content call travel in a
 * `Dropbox-API-Arg` **header** rather than a body, and that header must be plain
 * ASCII, so the JSON is escaped before it is sent.
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

const PROVIDER = 'dropbox' as const;
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export function dropboxAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // Both are required for Dropbox to issue a refresh token rather than a
    // short-lived access token that dies in four hours.
    token_access_type: 'offline',
    state,
  });
  return `${DROPBOX_AUTHORIZE_URL}?${q.toString()}`;
}

/**
 * Dropbox rejects a non-ASCII `Dropbox-API-Arg` header, and a filename with an
 * accent is entirely ordinary, so every non-ASCII character is escaped.
 */
function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[-￿]/g, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** Join the chosen folder and a key into a Dropbox path, always absolute. */
function pathFor(folderId: string | null, key: string): string {
  const folder = (folderId ?? '').replace(/^\/+|\/+$/g, '');
  const name = key.replace(/^\/+/, '');
  return folder === '' ? `/${name}` : `/${folder}/${name}`;
}

export function createDropboxProvider(
  app: OAuthApp,
  config: Record<string, string>,
  folderId: string | null,
): StorageProvider | null {
  const refreshToken = (config.refresh_token ?? '').trim();
  if (!refreshToken) return null;
  const token = tokenHolder(app, refreshToken);

  const rpc = (endpoint: string, body: unknown): Promise<Response> =>
    authed(token, `${API}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    provider: PROVIDER,

    async testConnection(): Promise<TestResult> {
      try {
        const path = pathFor(folderId, `murikah-connection-probe-${crypto.randomUUID()}.txt`);
        const put = await authed(token, `${CONTENT}/files/upload`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'Dropbox-API-Arg': apiArg({ path, mode: 'add', mute: true }),
          },
          body: 'murikah connection probe',
        });
        if (!put.ok) {
          const detail = await put.text();
          return {
            ok: false,
            error: `Dropbox refused a test write (HTTP ${put.status}): ${detail.slice(0, 200)}`,
          };
        }
        await rpc('/files/delete_v2', { path });
        return { ok: true, detail: 'Created and removed a probe file in the chosen folder.' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Dropbox is unreachable.' };
      }
    },

    async listFolders(parentPath?: string): Promise<StorageFolder[]> {
      // Dropbox names the account root as the empty string, not '/'.
      const path = (parentPath ?? folderId ?? '').replace(/\/+$/, '');
      const res = await rpc('/files/list_folder', {
        path: path === '' || path === '/' ? '' : path.startsWith('/') ? path : `/${path}`,
        recursive: false,
      });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        entries?: { '.tag'?: string; name?: string; path_lower?: string }[];
      };
      return (body.entries ?? [])
        .filter((e) => e['.tag'] === 'folder' && e.path_lower && e.name)
        .map((e) => ({
          id: String(e.path_lower).replace(/^\//, ''),
          name: String(e.name),
          path: String(e.path_lower),
        }));
    },

    async put(key, bytes, meta: PutMeta): Promise<StoredObjectRef> {
      const body =
        bytes instanceof ReadableStream ? await new Response(bytes).arrayBuffer() : bytes;
      const path = pathFor(folderId, key);
      const res = await authed(token, `${CONTENT}/files/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          // 'add' with autorename off: a key is unique by construction, so a
          // collision means something is wrong and should surface, not be
          // silently renamed into a file nobody will find again.
          'Dropbox-API-Arg': apiArg({ path, mode: 'add', autorename: false, mute: true }),
        },
        body: body as BodyInit,
      });
      if (!res.ok) throw new Error(`Dropbox refused the write (HTTP ${res.status}).`);
      void meta;
      return { backend: PROVIDER, key: path };
    },

    async get(key): Promise<ReadableStream> {
      const path = key.startsWith('/') ? key : pathFor(folderId, key);
      const res = await authed(token, `${CONTENT}/files/download`, {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': apiArg({ path }) },
      });
      if (!res.ok || !res.body) throw new Error('The evidence file was not found in Dropbox.');
      return res.body;
    },

    async head(key): Promise<ObjectHead | null> {
      const path = key.startsWith('/') ? key : pathFor(folderId, key);
      const res = await rpc('/files/get_metadata', { path });
      if (!res.ok) return null;
      const body = (await res.json()) as { size?: number };
      return { size: Number(body.size ?? 0) };
    },

    async presignedDownloadUrl(): Promise<string | null> {
      return null;
    },
    async presignedUploadUrl(): Promise<string | null> {
      return null;
    },

    async markForDeletion(key): Promise<void> {
      const path = key.startsWith('/') ? key : pathFor(folderId, key);
      await rpc('/files/delete_v2', { path });
    },
  };
}
