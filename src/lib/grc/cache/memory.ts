/**
 * An in-isolate cache, used in two places: the unit tests, and the fallback when
 * no shared backend is bound (local development, and the Cloudflare preview,
 * which deploys with no pre-created resources).
 *
 * It reports `shared: false`, and that is the important part. A write here is
 * invisible to every other isolate, so an invalidation cannot reach them either.
 * cache/core.ts therefore clamps every TTL to a few seconds against this
 * backend: correctness first, speed only where it is safe. Bind KV (or point at
 * Upstash) and the full lifetimes and immediate invalidation come back.
 *
 * Only the cache contract is imported, so node strips the types and the unit
 * tests run this directly.
 */
import type { GrcCache } from './types.ts';

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryCache implements GrcCache {
  readonly name = 'memory';
  readonly shared = false;

  private readonly store = new Map<string, Entry>();
  private readonly now: () => number;

  /** `now` is injectable so a test can travel forward without sleeping. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + Math.round(ttlSeconds * 1000) });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async deleteNamespace(prefix: string): Promise<number> {
    if (prefix === '') return 0;
    let removed = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** How many entries are held, expired ones included. For tests only. */
  get size(): number {
    return this.store.size;
  }
}
