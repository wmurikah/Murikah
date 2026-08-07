/**
 * Cache-aside, in two layers, with no Cloudflare binding in sight so the unit
 * tests can drive it directly.
 *
 * Layer one, the per-request memo. Repeated identical reads inside a single
 * request are deduped in a map that is discarded when the request ends. The map
 * hangs off the libSQL client in a WeakMap, and that client is created fresh per
 * request (src/lib/grc/db.ts), so the memo cannot outlive the request and cannot
 * be shared between two of them: there is no module-level map to leak. Storing
 * the in-flight promise, not the resolved value, also collapses concurrent
 * identical reads into one query.
 *
 * Layer two, the shared cache. On a memo miss, read the shared cache; on a miss
 * there, read the database and populate with a TTL. Every write path invalidates
 * through cache/invalidate.ts, which clears the shared entry and the memo
 * together, so a mutation followed by a read inside the same request sees the
 * new value.
 *
 * Three rules hold the correctness line:
 *
 * - An empty key means "not cacheable" and passes straight through to the
 *   database. cache/keys.ts returns the empty key when there is no acting
 *   organisation, so a platform owner inside no instance is never served, and
 *   never populates, a cached entry.
 * - Against a cache that is not shared across isolates, every TTL is clamped to
 *   LOCAL_MAX_TTL_SECONDS, because an invalidation in one isolate cannot reach
 *   the others and only a short lifetime bounds the staleness.
 * - A cache failure is never a request failure. A backend that throws is
 *   counted as an error and the database answers.
 */
import type { GrcCache } from './types.ts';
import { decodeEnvelope, encodeEnvelope } from './envelope.ts';
import { cacheStats } from './stats.ts';

/**
 * The ceiling for a backend that only one isolate can see. Long enough to blunt
 * a burst of identical reads, short enough that an edit is visible everywhere
 * within a few seconds even though no invalidation can cross isolates.
 */
export const LOCAL_MAX_TTL_SECONDS = 10;

/**
 * Anything with object identity that lives exactly as long as one request. The
 * repos pass their libSQL client, which is created per request.
 */
export type MemoOwner = object;

const memos = new WeakMap<MemoOwner, Map<string, Promise<unknown>>>();

function memoFor(owner: MemoOwner | null): Map<string, Promise<unknown>> | null {
  if (owner === null) return null;
  let memo = memos.get(owner);
  if (!memo) {
    memo = new Map();
    memos.set(owner, memo);
  }
  return memo;
}

function effectiveTtl(cache: GrcCache, ttlSeconds: number): number {
  return cache.shared ? ttlSeconds : Math.min(ttlSeconds, LOCAL_MAX_TTL_SECONDS);
}

/**
 * Read through the memo, then the shared cache, then the database.
 *
 * `load` is only called on a full miss, and its result is what populates both
 * layers. It must return a JSON-serialisable value, since that is what a shared
 * cache can hold; a read that cannot be serialised belongs uncached.
 */
export async function cacheAsideWith<T>(
  cache: GrcCache | null,
  owner: MemoOwner | null,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  if (key === '') {
    cacheStats.bypass();
    return load();
  }

  const memo = memoFor(owner);
  const memoised = memo?.get(key);
  if (memoised) {
    cacheStats.memoHit();
    return memoised as Promise<T>;
  }

  const pending = (async (): Promise<T> => {
    if (cache) {
      let raw: string | null = null;
      try {
        raw = await cache.get(key);
      } catch {
        cacheStats.error();
        raw = null;
      }
      const decoded = decodeEnvelope(raw, now());
      if (decoded.fresh) {
        cacheStats.hit();
        return decoded.value as T;
      }
    }

    cacheStats.miss();
    const value = await load();

    if (cache) {
      const ttl = effectiveTtl(cache, ttlSeconds);
      try {
        await cache.set(key, encodeEnvelope(value, now(), ttl), ttl);
        cacheStats.set();
      } catch {
        cacheStats.error();
      }
    }
    return value;
  })();

  if (memo) {
    memo.set(key, pending);
    // A failed read must not stick: drop it so the next attempt retries.
    pending.catch(() => memo.delete(key));
  }
  return pending;
}

/** Drop the named keys from the shared cache and from this request's memo. */
export async function invalidateKeysWith(
  cache: GrcCache | null,
  owner: MemoOwner | null,
  keys: readonly string[],
): Promise<void> {
  const memo = memoFor(owner);
  for (const key of keys) {
    if (key === '') continue;
    memo?.delete(key);
    if (!cache) continue;
    try {
      await cache.delete(key);
      cacheStats.delete();
    } catch {
      cacheStats.error();
    }
  }
}

/** Drop every entry under the named prefixes, memo included. */
export async function invalidatePrefixesWith(
  cache: GrcCache | null,
  owner: MemoOwner | null,
  prefixes: readonly string[],
): Promise<number> {
  const memo = memoFor(owner);
  let removed = 0;
  for (const prefix of prefixes) {
    if (prefix === '') continue;
    if (memo) {
      for (const key of [...memo.keys()]) {
        if (key.startsWith(prefix)) memo.delete(key);
      }
    }
    if (!cache) continue;
    try {
      removed += await cache.deleteNamespace(prefix);
      cacheStats.delete();
    } catch {
      cacheStats.error();
    }
  }
  return removed;
}
