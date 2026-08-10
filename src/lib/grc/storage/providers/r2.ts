/**
 * The Cloudflare R2 provider (Build Prompt 51).
 *
 * S3-compatible, configured per organisation with the customer's own account id,
 * bucket and access keys. Unlike the other three, R2 can hand the browser a
 * signed URL, so the object bytes move directly between the client and the
 * bucket and never pass through the Worker. That is why `presignedUploadUrl` and
 * `presignedDownloadUrl` return a URL here and null everywhere else.
 *
 * The chosen "folder" is a key prefix. Object keys are already tenant-scoped by
 * `storage/keys.ts`; the prefix sits in front of that, so a customer pointing
 * two environments at one bucket can keep them apart without either being able
 * to reach the other's keys through this provider.
 */
import type {
  ObjectHead,
  PutMeta,
  StorageFolder,
  StorageProvider,
  StoredObjectRef,
  TestResult,
} from '../provider';
import { presignR2Url } from '../sigv4';

const PROVIDER = 'r2' as const;
const PROBE_KEY = '.murikah-connection-probe';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional override; derived from the account id when blank. */
  endpoint?: string;
}

export function readR2Config(config: Record<string, string>): R2Config | null {
  const accountId = (config.account_id ?? '').trim();
  const bucket = (config.bucket ?? '').trim();
  const accessKeyId = (config.access_key_id ?? '').trim();
  const secretAccessKey = (config.secret_access_key ?? '').trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: (config.endpoint ?? '').trim() || undefined,
  };
}

/** The prefix an organisation chose, normalised to end in exactly one slash. */
function prefixed(folderId: string | null, key: string): string {
  const prefix = (folderId ?? '').replace(/^\/+|\/+$/g, '');
  return prefix === '' ? key : `${prefix}/${key}`;
}

export function createR2Provider(
  config: Record<string, string>,
  folderId: string | null,
): StorageProvider | null {
  const cfg = readR2Config(config);
  if (!cfg) return null;

  const sign = (
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    ttl: number,
  ): Promise<string> =>
    presignR2Url({
      method,
      accountId: cfg.accountId,
      bucket: cfg.bucket,
      key: prefixed(folderId, key),
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      expiresInSeconds: ttl,
      now: new Date(),
      endpoint: cfg.endpoint,
    });

  // Server-side operations go over the same signed URL rather than a bucket
  // binding: the binding is one bucket chosen at deploy time, and this provider
  // has to reach whichever bucket the customer configured.
  const request = async (
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    body?: BodyInit,
  ): Promise<Response> => {
    const url = await sign(method, key, 300);
    return fetch(url, { method, body });
  };

  return {
    provider: PROVIDER,

    async testConnection(): Promise<TestResult> {
      try {
        // Written and then removed, because a credential that can read but not
        // write is a connection that fails on the first real upload.
        const probe = `${PROBE_KEY}-${crypto.randomUUID()}`;
        const put = await request('PUT', probe, 'murikah connection probe');
        if (!put.ok) {
          return { ok: false, error: `The bucket refused a test write (HTTP ${put.status}).` };
        }
        const del = await request('DELETE', probe);
        const cleaned = del.ok || del.status === 204 || del.status === 404;
        return {
          ok: true,
          detail: cleaned
            ? `Wrote and removed a probe object in ${cfg.bucket}.`
            : `Wrote a probe object in ${cfg.bucket}; it could not be removed automatically.`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'The bucket is unreachable.',
        };
      }
    },

    async listFolders(): Promise<StorageFolder[]> {
      // R2 has no folders. The prefix is free text, so the picker offers the
      // bucket root and lets the administrator type one rather than inventing a
      // listing that would only ever reflect keys already written.
      return [{ id: '', name: `${cfg.bucket} (bucket root)`, path: '/' }];
    },

    async put(key, bytes, meta: PutMeta): Promise<StoredObjectRef> {
      const url = await sign('PUT', key, 300);
      const res = await fetch(url, {
        method: 'PUT',
        body: bytes as BodyInit,
        headers: { 'content-type': meta.contentType },
      });
      if (!res.ok) throw new Error(`R2 refused the write (HTTP ${res.status}).`);
      return { backend: PROVIDER, key };
    },

    async get(key): Promise<ReadableStream> {
      const res = await request('GET', key);
      if (!res.ok || !res.body) throw new Error('The evidence object was not found in R2.');
      return res.body;
    },

    async head(key): Promise<ObjectHead | null> {
      const res = await request('HEAD', key);
      if (!res.ok) return null;
      return { size: Number(res.headers.get('content-length') ?? 0) };
    },

    async presignedDownloadUrl(key, ttl): Promise<string | null> {
      return sign('GET', key, ttl);
    },

    async presignedUploadUrl(key, ttl): Promise<string | null> {
      return sign('PUT', key, ttl);
    },

    async markForDeletion(key): Promise<void> {
      await request('DELETE', key);
    },
  };
}
