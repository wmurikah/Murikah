/**
 * Cache hit and miss counting, so a cache problem is diagnosable.
 *
 * Counters live in the isolate that did the work, which on Cloudflare means the
 * numbers any one request can see are a sliver of the platform's. To give the
 * platform owner a real total, each isolate periodically folds its unreported
 * delta into one of a small, fixed set of shard keys in the shared cache, and
 * the diagnostics screen sums the shards. A fixed shard count keeps this inside
 * the four-method cache contract: no key enumeration is needed to read the
 * totals back.
 *
 * The roll-up is best effort by design. It is throttled to one write per isolate
 * per interval, a failed write puts the delta back so the next attempt carries
 * it, and two isolates writing the same shard in the same instant may lose a
 * few counts. Diagnostics must never cost correctness or latency on a user's
 * request, and an approximate hit rate is worth exactly as much as an exact one.
 *
 * The shard keys sit outside the `grc:v1:` root, so flushing an organisation's
 * namespace never disturbs them and no organisation id can collide with them.
 */
import type { CacheCounters, GrcCache } from './types.ts';
import { addCounters, countersAreEmpty, emptyCounters, parseCounters } from './envelope.ts';

const SHARD_COUNT = 8;
const SHARD_ROOT = 'grc:stats:v1:';
const SHARD_TTL_SECONDS = 3600;
const ROLLUP_INTERVAL_MS = 10_000;

/** Since this isolate started. */
let isolateTotals = emptyCounters();
/** Not yet folded into a shard. */
let unreported = emptyCounters();
let lastRollUpAt = 0;
let shardIndex: number | null = null;

/**
 * The shard this isolate reports into, chosen once and lazily (Workers forbids
 * work at module scope). Spreading isolates across shards keeps the read-modify
 * -write contention low without needing a key listing to read the totals.
 */
function shardKey(): string {
  if (shardIndex === null) shardIndex = Math.floor(Math.random() * SHARD_COUNT);
  return `${SHARD_ROOT}${shardIndex}`;
}

function bump(field: keyof CacheCounters): void {
  isolateTotals[field] += 1;
  unreported[field] += 1;
}

export const cacheStats = {
  hit: (): void => bump('hits'),
  miss: (): void => bump('misses'),
  memoHit: (): void => bump('memoHits'),
  set: (): void => bump('sets'),
  delete: (): void => bump('deletes'),
  bypass: (): void => bump('bypasses'),
  error: (): void => bump('errors'),
};

/** This isolate's counters since it started. */
export function isolateCounters(): CacheCounters {
  return { ...isolateTotals };
}

/** Clear the local counters. Used by the tests and after a platform-wide reset. */
export function resetIsolateCounters(): void {
  isolateTotals = emptyCounters();
  unreported = emptyCounters();
  lastRollUpAt = 0;
}

/**
 * Fold this isolate's unreported delta into its shard, at most once per
 * interval. Safe to call on every request; it usually returns without touching
 * the cache at all.
 */
export async function rollUpCacheStats(
  cache: GrcCache,
  now: number = Date.now(),
): Promise<boolean> {
  if (!cache.shared) return false;
  if (countersAreEmpty(unreported)) return false;
  if (now - lastRollUpAt < ROLLUP_INTERVAL_MS) return false;
  lastRollUpAt = now;

  const delta = unreported;
  unreported = emptyCounters();
  const key = shardKey();
  try {
    const existing = parseCounters(await cache.get(key));
    await cache.set(key, JSON.stringify(addCounters(existing, delta)), SHARD_TTL_SECONDS);
    return true;
  } catch {
    // Carry the delta forward rather than losing it; the next attempt takes it.
    unreported = addCounters(unreported, delta);
    return false;
  }
}

/** The rolled-up totals across every isolate that has reported into a shard. */
export async function readRolledUpCounters(cache: GrcCache): Promise<CacheCounters> {
  let total = emptyCounters();
  for (let i = 0; i < SHARD_COUNT; i++) {
    try {
      total = addCounters(total, parseCounters(await cache.get(`${SHARD_ROOT}${i}`)));
    } catch {
      // A shard that cannot be read simply contributes nothing.
    }
  }
  return total;
}

/** Clear every shard, so the owner can start a clean measurement. */
export async function clearRolledUpCounters(cache: GrcCache): Promise<void> {
  await cache.deleteNamespace(SHARD_ROOT);
}
