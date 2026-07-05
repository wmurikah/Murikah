/**
 * The Cloudflare R2 storage backend. The bucket binding handles head, get, put
 * and delete server-side; the S3 credentials sign presigned PUT and GET URLs so
 * the large object bytes flow straight between the client and R2, never through
 * the Worker. Keys are immutable: a replacement is a new file_id and key, so put
 * never overwrites an existing object.
 */
import type { StorageBackend, StoredObjectRef, PutInput, StoredObjectHead } from './types';
import { presignR2Url } from './sigv4';
import { getR2Bucket, getR2PresignConfig, type R2PresignConfig } from './env';

const NAME = 'r2';

function presignParams(cfg: R2PresignConfig, method: 'GET' | 'PUT', key: string, ttl: number) {
  return {
    method,
    accountId: cfg.accountId,
    bucket: cfg.bucket,
    key,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresInSeconds: ttl,
    now: new Date(),
  } as const;
}

/** The R2 backend, or null when the bucket binding is absent. */
export function getR2Backend(): StorageBackend | null {
  const bucket = getR2Bucket();
  if (!bucket) return null;
  const presign = getR2PresignConfig();

  return {
    name: NAME,
    async put(input: PutInput): Promise<StoredObjectRef> {
      await bucket.put(input.key, input.body, {
        httpMetadata: { contentType: input.contentType },
      });
      return { backend: NAME, key: input.key };
    },
    async get(ref: StoredObjectRef): Promise<ReadableStream> {
      const obj = await bucket.get(ref.key);
      if (!obj) throw new Error('The evidence object was not found in R2.');
      return obj.body;
    },
    async head(ref: StoredObjectRef): Promise<StoredObjectHead | null> {
      const obj = await bucket.head(ref.key);
      return obj ? { size: obj.size } : null;
    },
    async remove(ref: StoredObjectRef): Promise<void> {
      await bucket.delete(ref.key);
    },
    async presignPut(key: string, ttl: number): Promise<string> {
      if (!presign) throw new Error('R2 presign credentials are not configured.');
      return presignR2Url(presignParams(presign, 'PUT', key, ttl));
    },
    async presignGet(ref: StoredObjectRef, ttl: number): Promise<string> {
      if (!presign) throw new Error('R2 presign credentials are not configured.');
      return presignR2Url(presignParams(presign, 'GET', ref.key, ttl));
    },
  };
}
