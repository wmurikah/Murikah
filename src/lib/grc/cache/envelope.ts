/**
 * The stored value format, and the counter arithmetic, both pure.
 *
 * Every cached value is wrapped in an envelope carrying its own expiry, and the
 * expiry is enforced on read rather than trusted to the backend. That is what
 * lets a five second entry exist at all: Cloudflare KV floors `expirationTtl`
 * at sixty seconds, so the permission matrix would otherwise be pinned a minute
 * behind a grant change. The backend TTL becomes an eviction hint; the envelope
 * is the truth.
 *
 * A malformed or expired envelope reads as a miss, never as a value, so a bad
 * write or a format change between deploys degrades to a database read rather
 * than to wrong data on a screen.
 *
 * No imports beyond the types, so node strips the types and the unit tests run
 * this directly.
 */
import type { CacheCounters } from './types.ts';

interface Envelope {
  /** The cached value. */
  v: unknown;
  /** Expiry, epoch milliseconds. */
  e: number;
}

/** Wrap a value with its expiry, ready to store. */
export function encodeEnvelope(value: unknown, now: number, ttlSeconds: number): string {
  return JSON.stringify({ v: value, e: now + Math.round(ttlSeconds * 1000) } satisfies Envelope);
}

export interface DecodedEnvelope {
  /** True only for a well-formed, unexpired envelope. */
  fresh: boolean;
  value: unknown;
}

/** Unwrap a stored value, treating anything expired or malformed as a miss. */
export function decodeEnvelope(raw: string | null, now: number): DecodedEnvelope {
  if (raw === null) return { fresh: false, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fresh: false, value: undefined };
  }
  if (parsed === null || typeof parsed !== 'object') return { fresh: false, value: undefined };
  const envelope = parsed as Partial<Envelope>;
  if (typeof envelope.e !== 'number' || !('v' in envelope)) {
    return { fresh: false, value: undefined };
  }
  if (envelope.e <= now) return { fresh: false, value: undefined };
  return { fresh: true, value: envelope.v };
}

export function emptyCounters(): CacheCounters {
  return { hits: 0, misses: 0, memoHits: 0, sets: 0, deletes: 0, bypasses: 0, errors: 0 };
}

/** Sum two counter sets, so per-isolate deltas roll up into a platform total. */
export function addCounters(a: CacheCounters, b: CacheCounters): CacheCounters {
  return {
    hits: a.hits + b.hits,
    misses: a.misses + b.misses,
    memoHits: a.memoHits + b.memoHits,
    sets: a.sets + b.sets,
    deletes: a.deletes + b.deletes,
    bypasses: a.bypasses + b.bypasses,
    errors: a.errors + b.errors,
  };
}

/** True when nothing has happened, so an empty roll-up costs no write. */
export function countersAreEmpty(c: CacheCounters): boolean {
  return (
    c.hits === 0 &&
    c.misses === 0 &&
    c.memoHits === 0 &&
    c.sets === 0 &&
    c.deletes === 0 &&
    c.bypasses === 0 &&
    c.errors === 0
  );
}

/** Parse a stored counter set, tolerating a partial or malformed record. */
export function parseCounters(raw: string | null): CacheCounters {
  if (!raw) return emptyCounters();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyCounters();
  }
  if (parsed === null || typeof parsed !== 'object') return emptyCounters();
  const source = parsed as Record<string, unknown>;
  const base = emptyCounters();
  const out = emptyCounters();
  for (const field of Object.keys(base) as (keyof CacheCounters)[]) {
    const value = source[field];
    out[field] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return out;
}

/** The hit rate as a percentage of shared-cache lookups, 0 when there were none. */
export function hitRate(c: CacheCounters): number {
  const lookups = c.hits + c.misses;
  return lookups === 0 ? 0 : Math.round((c.hits / lookups) * 1000) / 10;
}
