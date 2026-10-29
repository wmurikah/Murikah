/**
 * The shared cache contract for the GRC platform.
 *
 * Deliberately tiny, and deliberately string in and string out, so the backend
 * is a swap and never a rewrite: the Cloudflare KV default (cache/kv.ts) and an
 * external Upstash Redis over HTTP (cache/upstash.ts) both satisfy it, and no
 * caller ever names one. On Cloudflare Workers there is no in-process Redis to
 * run, so the native edge cache is the default and Redis is the later option,
 * not the other way round.
 *
 * It is `GrcCache`, not `Cache`, because `Cache` is a Workers global.
 *
 * Two readonly properties sit alongside the four methods, for the layer above
 * rather than for callers:
 *
 * - `name` labels the backend in the platform owner's diagnostics.
 * - `shared` says whether an entry written here is visible to, and deletable
 *   from, another isolate. It is false only for the in-isolate memory fallback
 *   used when nothing is bound, and cache/core.ts clamps every TTL hard when it
 *   is false, because a write in one isolate cannot invalidate another's copy.
 *
 * This module has no imports, so node strips the types and the unit tests run
 * it directly.
 */

export interface GrcCache {
  /** A short backend name for diagnostics, e.g. 'cloudflare-kv'. */
  readonly name: string;
  /** True when entries are visible across isolates and edges (KV, Redis). */
  readonly shared: boolean;
  /** The raw stored string, or null when absent. Never throws for a miss. */
  get(key: string): Promise<string | null>;
  /** Store a value. `ttlSeconds` is the intent; a backend may floor it. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete every key under a prefix, returning how many were removed. */
  deleteNamespace(prefix: string): Promise<number>;
}

/**
 * Cache activity, counted for the platform owner. `memoHits` are served by the
 * per-request memo and never touch the shared cache; `bypasses` are reads that
 * were deliberately not cacheable (no acting organisation, or a key outside the
 * cacheable allow-list), which is a healthy number rather than a fault.
 */
export interface CacheCounters {
  hits: number;
  misses: number;
  memoHits: number;
  sets: number;
  deletes: number;
  bypasses: number;
  errors: number;
}

/** What the diagnostics endpoint reports. */
export interface CacheStatsReport {
  /** The rolled-up totals across every isolate that reported. */
  total: CacheCounters;
  /** The counters of the isolate serving this request, since it started. */
  isolate: CacheCounters;
  /** The backend in use, and whether it is shared across edges. */
  backend: { name: string; shared: boolean };
}
