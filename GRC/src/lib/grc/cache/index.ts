/**
 * The cache the GRC platform actually runs against: backend resolution, and the
 * three primitives every repo uses.
 *
 * Backend order, decided once per isolate and never at a call site:
 *
 *   1. Upstash Redis over HTTP, when GRC_CACHE_REDIS_URL and
 *      GRC_CACHE_REDIS_TOKEN are set. The documented swap; setting two secrets
 *      is the whole migration.
 *   2. Cloudflare KV, bound as GRC_CACHE (or the existing CACHE namespace). The
 *      default, because a Worker cannot run a Redis server in-process.
 *   3. An in-isolate memory cache, when nothing is bound. Local development and
 *      the no-resource Cloudflare preview. It reports `shared: false`, which
 *      makes cache/core.ts clamp every lifetime to a few seconds, since an
 *      invalidation in one isolate cannot reach another.
 *
 * What is never cached here, at any layer beyond the per-request memo: the
 * session, its validity, and the user's identity. Authentication is resolved
 * fresh from the database on every request, in src/middleware.ts, and nothing
 * in this module is reachable from that path.
 *
 * See grc/docs/caching.md for the whole design and the Upstash cut-over.
 */
import { env } from 'cloudflare:workers';
import type { CacheStatsReport, GrcCache } from './types.ts';
import { KvCache } from './kv.ts';
import { MemoryCache } from './memory.ts';
import { UpstashCache } from './upstash.ts';
import {
  cacheAsideWith,
  invalidateKeysWith,
  invalidatePrefixesWith,
  type MemoOwner,
} from './core.ts';
import {
  clearRolledUpCounters,
  isolateCounters,
  readRolledUpCounters,
  resetIsolateCounters,
  rollUpCacheStats,
} from './stats.ts';

export { cacheKeys, CACHE_TTL, CACHE_VERSION, namespaceFor, PLATFORM_NAMESPACE } from './keys.ts';
export type { GrcCache, CacheCounters, CacheStatsReport } from './types.ts';
export type { MemoOwner } from './core.ts';
export { hitRate } from './envelope.ts';

let resolved: GrcCache | null = null;

/** The shared cache backend for this isolate, resolved once from the bindings. */
export function getCache(): GrcCache {
  if (resolved) return resolved;
  resolved = resolveCache();
  return resolved;
}

function resolveCache(): GrcCache {
  try {
    const url = env.GRC_CACHE_REDIS_URL;
    const token = env.GRC_CACHE_REDIS_TOKEN;
    if (url && token) return new UpstashCache({ url, token });
    const kv = env.GRC_CACHE ?? env.CACHE;
    if (kv) return new KvCache(kv);
  } catch (err) {
    // No Worker env (a script, a unit test): fall through to the memory cache.
    console.error('[grc.cache] no binding available, using the in-isolate cache', err);
  }
  return new MemoryCache();
}

/**
 * Cache-aside read. `owner` is the request-scoped object the memo hangs off:
 * repos pass their libSQL client, which is created per request.
 */
export function cached<T>(
  owner: MemoOwner | null,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  return cacheAsideWith(getCache(), owner, key, ttlSeconds, load);
}

/** Drop the named keys, from the shared cache and from this request's memo. */
export function invalidateKeys(owner: MemoOwner | null, keys: readonly string[]): Promise<void> {
  return invalidateKeysWith(getCache(), owner, keys);
}

/** Drop every entry under the named prefixes, memo included. */
export function invalidatePrefixes(
  owner: MemoOwner | null,
  prefixes: readonly string[],
): Promise<number> {
  return invalidatePrefixesWith(getCache(), owner, prefixes);
}

/**
 * Fold this isolate's counters into the shared roll-up. Called after the
 * response is decided, through waitUntil where one is available, so diagnostics
 * never sit in a user's critical path. Throttled inside, so calling it on every
 * request is cheap.
 */
export function scheduleCacheStatsRollUp(waitUntil?: (promise: Promise<unknown>) => void): void {
  const pending = rollUpCacheStats(getCache()).catch(() => false);
  if (waitUntil) waitUntil(pending);
}

/** Hits, misses and the rest, for the platform owner's diagnostics screen. */
export async function cacheStatsReport(): Promise<CacheStatsReport> {
  const cache = getCache();
  return {
    total: await readRolledUpCounters(cache),
    isolate: isolateCounters(),
    backend: { name: cache.name, shared: cache.shared },
  };
}

/** Reset the counters, so the owner can start a clean measurement. */
export async function resetCacheStats(): Promise<void> {
  await clearRolledUpCounters(getCache());
  resetIsolateCounters();
}
