/**
 * The SharePoint / OneDrive provider, over Microsoft Graph (Build Prompt 51).
 *
 * The organisation connects a Microsoft account once with `Files.ReadWrite.All`;
 * the refresh token rests sealed against that organisation. The administrator
 * then picks a drive and a folder, and both ids are stored: a folder id alone is
 * ambiguous across drives, so the pair is what identifies the destination.
 *
 * `folderId` is stored as `driveId/itemId`, or just `itemId` when the drive is
 * the connected account's own. Splitting it here rather than adding a column
 * keeps the connection row provider-agnostic, which is what lets a fifth
 * provider arrive without a migration.
 *
 * Graph authenticates with a bearer token, so no presigned URL is issued and the
 * bytes stream through the Worker.
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

const PROVIDER = 'sharepoint' as const;
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const MS_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MS_SCOPE = 'offline_access Files.ReadWrite.All Sites.Read.All User.Read';

export function microsoftAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPE,
    state,
  });
  return `${MS_AUTHORIZE_URL}?${q.toString()}`;
}

/** Split the stored `driveId/itemId` (or a bare item id) into its two parts. */
export function splitFolderRef(folderId: string | null): {
  driveId: string | null;
  itemId: string;
} {
  const raw = (folderId ?? '').trim();
  if (raw === '') return { driveId: null, itemId: 'root' };
  const slash = raw.indexOf('/');
  if (slash === -1) return { driveId: null, itemId: raw };
  return { driveId: raw.slice(0, slash), itemId: raw.slice(slash + 1) || 'root' };
}

export function createSharePointProvider(
  app: OAuthApp,
  config: Record<string, string>,
  folderId: string | null,
): StorageProvider | null {
  const refreshToken = (config.refresh_token ?? '').trim();
  if (!refreshToken) return null;
  const token = tokenHolder(app, refreshToken, MS_SCOPE);
  const { driveId, itemId } = splitFolderRef(folderId);
  const driveRoot = driveId ? `${GRAPH}/drives/${driveId}` : `${GRAPH}/me/drive`;

  /** Graph addresses a child by name under a parent item. */
  const childPath = (name: string): string =>
    `${driveRoot}/items/${itemId}:/${encodeURIComponent(name)}:`;

  return {
    provider: PROVIDER,

    async testConnection(): Promise<TestResult> {
      try {
        const name = `murikah-connection-probe-${crypto.randomUUID()}.txt`;
        const put = await authed(token, `${childPath(name)}/content`, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: 'murikah connection probe',
        });
        if (!put.ok) {
          return {
            ok: false,
            error: `The chosen folder refused a test write (HTTP ${put.status}).`,
          };
        }
        const { id } = (await put.json()) as { id?: string };
        if (id) await authed(token, `${driveRoot}/items/${id}`, { method: 'DELETE' });
        return { ok: true, detail: 'Created and removed a probe file in the chosen folder.' };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Microsoft Graph is unreachable.',
        };
      }
    },

    async listFolders(parentItemId?: string): Promise<StorageFolder[]> {
      const parent = parentItemId ?? itemId;
      const url =
        parent === 'root'
          ? `${driveRoot}/root/children?$select=id,name,folder`
          : `${driveRoot}/items/${parent}/children?$select=id,name,folder`;
      const res = await authed(token, url);
      if (!res.ok) return [];
      const body = (await res.json()) as {
        value?: { id?: string; name?: string; folder?: unknown }[];
      };
      return (body.value ?? [])
        .filter((v) => v.folder && v.id && v.name)
        .map((v) => ({
          // Carry the drive with the item, so the stored reference stays whole.
          id: driveId ? `${driveId}/${v.id}` : String(v.id),
          name: String(v.name),
        }));
    },

    async put(key, bytes, meta: PutMeta): Promise<StoredObjectRef> {
      const body =
        bytes instanceof ReadableStream ? await new Response(bytes).arrayBuffer() : bytes;
      const res = await authed(token, `${childPath(meta.fileName ?? key)}/content`, {
        method: 'PUT',
        headers: { 'content-type': meta.contentType },
        body: body as BodyInit,
      });
      if (!res.ok) throw new Error(`Graph refused the write (HTTP ${res.status}).`);
      const { id } = (await res.json()) as { id?: string };
      if (!id) throw new Error('Graph returned no item id for the written object.');
      return { backend: PROVIDER, key: driveId ? `${driveId}/${id}` : id };
    },

    async get(key): Promise<ReadableStream> {
      const { driveId: d, itemId: i } = splitFolderRef(key);
      const root = d ? `${GRAPH}/drives/${d}` : `${GRAPH}/me/drive`;
      const res = await authed(token, `${root}/items/${i}/content`);
      if (!res.ok || !res.body) throw new Error('The evidence file was not found in SharePoint.');
      return res.body;
    },

    async head(key): Promise<ObjectHead | null> {
      const { driveId: d, itemId: i } = splitFolderRef(key);
      const root = d ? `${GRAPH}/drives/${d}` : `${GRAPH}/me/drive`;
      const res = await authed(token, `${root}/items/${i}?$select=size`);
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
      const { driveId: d, itemId: i } = splitFolderRef(key);
      const root = d ? `${GRAPH}/drives/${d}` : `${GRAPH}/me/drive`;
      await authed(token, `${root}/items/${i}`, { method: 'DELETE' });
    },
  };
}
