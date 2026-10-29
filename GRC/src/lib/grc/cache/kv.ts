/**
 * The default shared cache: Cloudflare Workers KV.
 *
 * A Redis server cannot run in-process on Workers, so the native edge cache is
 * the default. KV is eventually consistent, which shapes two decisions above
 * this file: the permission matrix TTL is capped at a few seconds so a grant
 * change lands everywhere quickly even where a delete has not yet propagated,
 * and nothing session or identity related is ever written here at all.
 *
 * KV floors `expirationTtl` at sixty seconds, so a shorter intent is stored as
 * sixty and the real lifetime is carried in the envelope and enforced on read
 * (cache/envelope.ts). The floor only makes an entry linger physically; it can
 * never make an expired entry readable.
 */
import type { GrcCache } from './types.ts';

/** Cloudflare rejects an `expirationTtl` below sixty seconds. */
const KV_MIN_TTL_SECONDS = 60;

export class KvCache implements GrcCache {
  readonly name = 'cloudflare-kv';
  readonly shared = true;

  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key, 'text');
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const expirationTtl = Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlSeconds));
    await this.kv.put(key, value, { expirationTtl });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async deleteNamespace(prefix: string): Promise<number> {
    if (prefix === '') return 0;
    let cursor: string | undefined;
    let removed = 0;
    for (;;) {
      const page = await this.kv.list({ prefix, cursor });
      for (const entry of page.keys) {
        await this.kv.delete(entry.name);
        removed++;
      }
      if (page.list_complete) return removed;
      cursor = page.cursor;
    }
  }
}
