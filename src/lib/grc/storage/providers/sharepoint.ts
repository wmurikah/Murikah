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

/** How many sites the picker will enumerate drives for, so it always answers. */
const SITE_LIMIT = 15;

/**
 * The document libraries this account can write to: its own OneDrive, and the
 * drives of the SharePoint sites it can see. This is the "site and drive" half
 * of the picker; a site with no drive the account can reach simply contributes
 * nothing rather than an entry that would fail on selection.
 */
async function listDrives(token: () => Promise<string>): Promise<StorageFolder[]> {
  const out: StorageFolder[] = [];
  const mine = await authed(token, `${GRAPH}/me/drive?$select=id,name`);
  if (mine.ok) {
    const drive = (await mine.json()) as { id?: string; name?: string };
    if (drive.id) {
      out.push({ id: `${drive.id}/root`, name: `OneDrive — ${drive.name ?? 'my files'}` });
    }
  }
  const sites = await authed(token, `${GRAPH}/sites?search=*&$select=id,displayName,name`);
  if (!sites.ok) return out;
  const body = (await sites.json()) as {
    value?: { id?: string; displayName?: string; name?: string }[];
  };
  for (const site of (body.value ?? []).slice(0, SITE_LIMIT)) {
    if (!site.id) continue;
    const drives = await authed(token, `${GRAPH}/sites/${site.id}/drives?$select=id,name`);
    if (!drives.ok) continue;
    const list = (await drives.json()) as { value?: { id?: string; name?: string }[] };
    const label = site.displayName ?? site.name ?? 'Site';
    for (const drive of list.value ?? []) {
      if (drive.id)
        out.push({ id: `${drive.id}/root`, name: `${label} — ${drive.name ?? 'Documents'}` });
    }
  }
  return out;
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

    /**
     * The picker walks site, then drive, then folder.
     *
     * Before a drive is chosen there is nothing to list children of, so the
     * first answer is the document libraries themselves: the connected
     * account's own OneDrive, and the libraries of the SharePoint sites it can
     * see, each labelled with its site. Choosing one records the drive; asking
     * again then drills into that drive's folders. Every entry carries its
     * drive in the id, so a selection is never ambiguous across drives.
     */
    async listFolders(parent?: string): Promise<StorageFolder[]> {
      const ref = splitFolderRef(parent ?? folderId);
      if (!ref.driveId) return listDrives(token);
      const root = `${GRAPH}/drives/${ref.driveId}`;
      const url =
        ref.itemId === 'root'
          ? `${root}/root/children?$select=id,name,folder`
          : `${root}/items/${ref.itemId}/children?$select=id,name,folder`;
      const res = await authed(token, url);
      if (!res.ok) return [];
      const body = (await res.json()) as {
        value?: { id?: string; name?: string; folder?: unknown }[];
      };
      return (body.value ?? [])
        .filter((v) => v.folder && v.id && v.name)
        .map((v) => ({
          // Carry the drive with the item, so the stored reference stays whole.
          id: `${ref.driveId}/${v.id}`,
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
