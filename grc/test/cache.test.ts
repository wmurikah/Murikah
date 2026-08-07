/**
 * The cache-aside layer (Build Prompt 42).
 *
 * These cover the whole of the layer that can be reasoned about without a
 * Worker: the key naming and its tenancy properties, the envelope that carries
 * the logical expiry, the two-layer read (per-request memo in front of a shared
 * cache), invalidation, and the fact that nothing an access decision rests on is
 * cacheable at all (Build Prompt 43).
 *
 * Everything imported here is free of Cloudflare bindings by design: the backend
 * resolution lives in cache/index.ts and the cache-aside core in cache/core.ts,
 * so the core can be driven directly against the memory and Upstash backends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKeys,
  namespaceFor,
  CACHE_TTL,
  PLATFORM_NAMESPACE,
} from '../../src/lib/grc/cache/keys.ts';
import {
  encodeEnvelope,
  decodeEnvelope,
  emptyCounters,
  addCounters,
  parseCounters,
  hitRate,
} from '../../src/lib/grc/cache/envelope.ts';
import { MemoryCache } from '../../src/lib/grc/cache/memory.ts';
import { UpstashCache } from '../../src/lib/grc/cache/upstash.ts';
import {
  cacheAsideWith,
  invalidateKeysWith,
  invalidatePrefixesWith,
  LOCAL_MAX_TTL_SECONDS,
} from '../../src/lib/grc/cache/core.ts';

const HASS = 'org-hass';
const OTHER = 'org-other';

// ---- Keys and tenancy -------------------------------------------------------

test('every tenant key is namespaced under its organisation', () => {
  for (const key of [
    cacheKeys.auditAreas(HASS),
    cacheKeys.subAreas(HASS, 'area-1'),
    cacheKeys.affiliates(HASS),
    cacheKeys.lookupAuditAreas(HASS),
    cacheKeys.lookupSubAreas(HASS, undefined),
    cacheKeys.dropdown(HASS, 'DROPDOWN_RISK_RATINGS'),
    cacheKeys.config(HASS, 'RESPONSE_DEADLINE_DAYS'),
    cacheKeys.subscription(HASS),
    cacheKeys.dashboard(HASS, 'stats', 'org'),
  ]) {
    assert.ok(key.startsWith(namespaceFor(HASS)), `${key} must sit in the organisation namespace`);
    assert.ok(!key.startsWith(namespaceFor(OTHER)), `${key} must not sit in another's namespace`);
  }
});

test('two organisations never share a key', () => {
  assert.notEqual(cacheKeys.auditAreas(HASS), cacheKeys.auditAreas(OTHER));
  assert.notEqual(
    cacheKeys.dashboard(HASS, 'stats', 'org'),
    cacheKeys.dashboard(OTHER, 'stats', 'org'),
  );
  // The namespaces are disjoint prefixes, so flushing one cannot reach the other.
  assert.ok(!namespaceFor(HASS).startsWith(namespaceFor(OTHER)));
  assert.ok(!namespaceFor(OTHER).startsWith(namespaceFor(HASS)));
});

test('a colon in an identifier cannot forge another namespace', () => {
  // Without encoding, an organisation id of `a:b` would produce keys that look
  // as though they belong under organisation `a`.
  const forged = namespaceFor(`${HASS}:audit-universe`);
  assert.ok(!forged.startsWith(`${namespaceFor(HASS)}audit-universe`));
  assert.ok(forged.includes('%3A'), 'the separator must be encoded, not passed through');
});

test('no acting organisation yields no key at all, so nothing is cached', () => {
  assert.equal(namespaceFor(''), '');
  assert.equal(cacheKeys.auditAreas(''), '');
  assert.equal(cacheKeys.dashboard('', 'stats', 'org'), '');
  assert.equal(cacheKeys.dashboardPrefix(''), '');
});

test('platform reference data sits outside every tenant namespace', () => {
  const labels = cacheKeys.enumLabels('WORK_PAPER_STATUS');
  assert.ok(labels.startsWith(namespaceFor(PLATFORM_NAMESPACE)));
  assert.ok(!labels.startsWith(namespaceFor(HASS)));
  // Keyed by enum type alone: no organisation can pollute another's.
  assert.notEqual(labels, cacheKeys.enumLabels('ACTION_PLAN_STATUS'));
  assert.ok(labels.startsWith(cacheKeys.enumLabelsPrefix()));
});

test('the lifetimes are the two the catalogue declares', () => {
  assert.ok(CACHE_TTL.dashboard >= 30 && CACHE_TTL.dashboard <= 60);
  assert.ok(CACHE_TTL.reference > CACHE_TTL.dashboard);
});

// ---- The envelope -----------------------------------------------------------

test('the envelope carries its own expiry, independent of the backend', () => {
  const raw = encodeEnvelope({ n: 1 }, 1_000, 5);
  assert.deepEqual(decodeEnvelope(raw, 1_000), { fresh: true, value: { n: 1 } });
  assert.deepEqual(decodeEnvelope(raw, 5_999), { fresh: true, value: { n: 1 } });
  // Expired: a miss, even though the backend still holds the bytes.
  assert.equal(decodeEnvelope(raw, 6_000).fresh, false);
  assert.equal(decodeEnvelope(raw, 60_000).fresh, false);
});

test('a malformed or absent envelope reads as a miss, never as a value', () => {
  assert.equal(decodeEnvelope(null, 0).fresh, false);
  assert.equal(decodeEnvelope('not json', 0).fresh, false);
  assert.equal(decodeEnvelope('{"v":1}', 0).fresh, false); // no expiry
  assert.equal(decodeEnvelope('"a string"', 0).fresh, false);
  assert.equal(decodeEnvelope('null', 0).fresh, false);
});

test('counters add up and report a hit rate', () => {
  const a = { ...emptyCounters(), hits: 3, misses: 1 };
  const b = { ...emptyCounters(), hits: 5, errors: 2 };
  const sum = addCounters(a, b);
  assert.equal(sum.hits, 8);
  assert.equal(sum.misses, 1);
  assert.equal(sum.errors, 2);
  assert.equal(hitRate(sum), 88.9);
  assert.equal(hitRate(emptyCounters()), 0);
  assert.deepEqual(parseCounters(JSON.stringify(sum)), sum);
  assert.deepEqual(parseCounters('rubbish'), emptyCounters());
  assert.deepEqual(parseCounters(null), emptyCounters());
});

// ---- Cache-aside: hit, miss, dedupe -----------------------------------------

/** A clock the tests move by hand, so expiry is exercised without sleeping. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A loader that records how many times it actually reached the database. */
function counted<T>(value: T): { load: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => {
      calls++;
      return value;
    },
    calls: () => calls,
  };
}

test('a miss reads through and populates; the next read is a hit', async () => {
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);
  const key = cacheKeys.affiliates(HASS);
  const first = counted(['HASS-KE']);

  // Two different request scopes, so the memo cannot be what serves the second.
  const requestA = {};
  const requestB = {};

  const a = await cacheAsideWith(cache, requestA, key, CACHE_TTL.reference, first.load, clock.now);
  assert.deepEqual(a, ['HASS-KE']);
  assert.equal(first.calls(), 1, 'the first read must reach the database');

  const second = counted(['SHOULD NOT BE READ']);
  const b = await cacheAsideWith(cache, requestB, key, CACHE_TTL.reference, second.load, clock.now);
  assert.deepEqual(b, ['HASS-KE'], 'the second request is served from the shared cache');
  assert.equal(second.calls(), 0, 'a hit must not reach the database');
});

test('the per-request memo dedupes identical reads and is scoped to the request', async () => {
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);
  const key = cacheKeys.lookupAuditAreas(HASS);
  const loader = counted([{ id: 'a1', label: 'Finance' }]);
  const request = {};

  // Ten identical reads inside one request, issued concurrently.
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      cacheAsideWith(cache, request, key, CACHE_TTL.reference, loader.load, clock.now),
    ),
  );
  assert.equal(loader.calls(), 1, 'concurrent identical reads collapse into one query');
  for (const r of results) assert.deepEqual(r, [{ id: 'a1', label: 'Finance' }]);
});

test('an unreachable backend degrades to the database rather than failing', async () => {
  const clock = fakeClock();
  const broken = {
    name: 'broken',
    shared: true,
    get: async (): Promise<string | null> => {
      throw new Error('backend down');
    },
    set: async (): Promise<void> => {
      throw new Error('backend down');
    },
    delete: async (): Promise<void> => {
      throw new Error('backend down');
    },
    deleteNamespace: async (): Promise<number> => {
      throw new Error('backend down');
    },
  };
  const loader = counted('value from the database');
  const value = await cacheAsideWith(
    broken,
    {},
    cacheKeys.affiliates(HASS),
    CACHE_TTL.reference,
    loader.load,
    clock.now,
  );
  assert.equal(value, 'value from the database');
  assert.equal(loader.calls(), 1);
  // An invalidation against a broken backend must not throw either.
  await invalidateKeysWith(broken, {}, [cacheKeys.affiliates(HASS)]);
  await invalidatePrefixesWith(broken, {}, [cacheKeys.affiliatesPrefix(HASS)]);
});

test('an entry expires on its own lifetime even if the backend holds it longer', async () => {
  const clock = fakeClock();
  // A backend that ignores the TTL entirely, the worst case Cloudflare KV's
  // sixty second floor approximates.
  const forever = new MemoryCache(() => 0);
  const loader = counted('first');
  const key = cacheKeys.enumLabels('WORK_PAPER_STATUS');

  await cacheAsideWith(forever, null, key, CACHE_TTL.dashboard, loader.load, clock.now);
  clock.advance(CACHE_TTL.dashboard * 1000 + 1);
  const after = counted('second');
  const value = await cacheAsideWith(
    forever,
    null,
    key,
    CACHE_TTL.dashboard,
    after.load,
    clock.now,
  );
  assert.equal(value, 'second', 'the envelope expiry must be enforced on read');
  assert.equal(after.calls(), 1);
});

test('a key that is not cacheable passes straight through every time', async () => {
  const cache = new MemoryCache();
  const loader = counted('fresh every time');
  const request = {};
  // No acting organisation, so cacheKeys returns the empty key.
  for (let i = 0; i < 3; i++) {
    await cacheAsideWith(cache, request, cacheKeys.auditAreas(''), 300, loader.load);
  }
  assert.equal(loader.calls(), 3, 'nothing may be cached without an acting organisation');
  assert.equal(cache.size, 0, 'and nothing may be written');
});

// ---- Invalidation -----------------------------------------------------------

test('invalidating a key clears the shared entry and the request memo together', async () => {
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);
  const key = cacheKeys.affiliates(HASS);
  const request = {};

  const before = counted('before the edit');
  await cacheAsideWith(cache, request, key, CACHE_TTL.reference, before.load, clock.now);

  await invalidateKeysWith(cache, request, [key]);

  const after = counted('after the edit');
  const value = await cacheAsideWith(
    cache,
    request,
    key,
    CACHE_TTL.reference,
    after.load,
    clock.now,
  );
  assert.equal(value, 'after the edit', 'the same request must see its own write');
  assert.equal(after.calls(), 1);
});

test('a prefix invalidation clears the whole namespace and nobody else', async () => {
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);
  const request = {};
  const seed = async (key: string, value: string): Promise<void> => {
    await cacheAsideWith(cache, request, key, CACHE_TTL.reference, async () => value, clock.now);
  };

  await seed(cacheKeys.auditAreas(HASS), 'hass areas');
  await seed(cacheKeys.subAreas(HASS, 'area-1'), 'hass subs');
  await seed(cacheKeys.affiliates(HASS), 'hass affiliates');
  await seed(cacheKeys.auditAreas(OTHER), 'other areas');

  const removed = await invalidatePrefixesWith(cache, request, [
    cacheKeys.auditUniversePrefix(HASS),
  ]);
  assert.equal(removed, 2, 'both audit-universe entries go');

  assert.equal(await cache.get(cacheKeys.auditAreas(HASS)), null);
  assert.equal(await cache.get(cacheKeys.subAreas(HASS, 'area-1')), null);
  assert.ok(await cache.get(cacheKeys.affiliates(HASS)), 'a sibling namespace is untouched');
  assert.ok(await cache.get(cacheKeys.auditAreas(OTHER)), "another tenant's entry is untouched");
});

test('flushing an organisation removes only that organisation', async () => {
  const cache = new MemoryCache();
  const request = {};
  const seed = async (key: string): Promise<void> => {
    await cacheAsideWith(cache, request, key, CACHE_TTL.reference, async () => 'x');
  };
  await seed(cacheKeys.auditAreas(HASS));
  await seed(cacheKeys.affiliates(HASS));
  await seed(cacheKeys.dashboard(HASS, 'stats', 'org'));
  await seed(cacheKeys.affiliates(OTHER));

  const removed = await invalidatePrefixesWith(cache, request, [namespaceFor(HASS)]);
  assert.equal(removed, 3);
  assert.ok(await cache.get(cacheKeys.affiliates(OTHER)), 'the other tenant survives the flush');
});

// ---- The immediacy requirement ---------------------------------------------

test('the permission matrix has no cache key and no lifetime (Build Prompt 43)', () => {
  // The strongest guarantee available: an access change cannot be served stale
  // by an entry that does not exist. The matrix is read fresh from the database
  // on every request (src/lib/grc/auth/rbac.ts), so there is nothing here to
  // invalidate and nothing to expire. A key reappearing in the catalogue is the
  // regression this test exists to catch.
  assert.equal('roleMatrix' in cacheKeys, false, 'the matrix must not be cacheable');
  assert.equal('roleMatrixPrefix' in cacheKeys, false);
  assert.equal('roleMatrix' in CACHE_TTL, false, 'no authorisation lifetime belongs here');
  // Nothing else in the catalogue may name a permission entry by another name.
  for (const [name, build] of Object.entries(cacheKeys)) {
    const key = (build as (...args: string[]) => string)(HASS, 'x', 'y');
    assert.ok(
      !/permission|role|grant|matrix/i.test(key),
      `${name} must not key an access decision`,
    );
  }
});

test('an invalidated reference entry is reflected on the very next read', async () => {
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);
  const key = cacheKeys.affiliates(HASS);

  let rows = ['HKL'];
  const readAffiliates = (): Promise<string[]> => Promise.resolve(rows);

  // Request one warms the cache.
  const first = await cacheAsideWith(
    cache,
    {},
    key,
    CACHE_TTL.reference,
    readAffiliates,
    clock.now,
  );
  assert.deepEqual(first, ['HKL']);

  // An administrator adds one, and the write invalidates.
  rows = ['HKL', 'HPL'];
  await invalidateKeysWith(cache, null, [key]);

  // The very next request, in a fresh request scope, sees it, with no clock
  // advance at all.
  const next = await cacheAsideWith(cache, {}, key, CACHE_TTL.reference, readAffiliates, clock.now);
  assert.deepEqual(next, ['HKL', 'HPL'], 'the new row must be there at once');
});

// ---- The backend is a swap --------------------------------------------------

test('a cache that is not shared has its lifetimes clamped', async () => {
  const clock = fakeClock();
  const local = new MemoryCache(clock.now);
  assert.equal(local.shared, false);
  const key = cacheKeys.affiliates(HASS);

  await cacheAsideWith(local, null, key, CACHE_TTL.reference, async () => 'v1', clock.now);
  // The reference lifetime is five minutes, but nothing here can be invalidated
  // from another isolate, so the entry must not survive the local ceiling.
  clock.advance(LOCAL_MAX_TTL_SECONDS * 1000 + 1);
  const loader = counted('v2');
  const value = await cacheAsideWith(local, null, key, CACHE_TTL.reference, loader.load, clock.now);
  assert.equal(value, 'v2');
  assert.equal(loader.calls(), 1);
});

test('the Upstash backend satisfies the same contract, over HTTP', async () => {
  const store = new Map<string, string>();
  const sent: string[][] = [];
  const fakeFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const args = JSON.parse(String(init.body)) as string[];
    sent.push(args);
    const [command, ...rest] = args;
    let result: unknown = null;
    if (command === 'GET') result = store.get(rest[0]) ?? null;
    else if (command === 'SET') {
      store.set(rest[0], rest[1]);
      result = 'OK';
    } else if (command === 'DEL') {
      for (const k of rest) store.delete(k);
      result = rest.length;
    } else if (command === 'SCAN') {
      const match = rest[2].replace(/\*$/, '');
      result = ['0', [...store.keys()].filter((k) => k.startsWith(match))];
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  };

  const cache = new UpstashCache({ url: 'https://example.upstash.io', token: 'token' }, fakeFetch);
  assert.equal(cache.shared, true);

  // The same cache-aside core, unchanged, over a different backend.
  const clock = fakeClock();
  const key = cacheKeys.affiliates(HASS);
  const first = counted('from the database');
  const a = await cacheAsideWith(cache, null, key, CACHE_TTL.reference, first.load, clock.now);
  const second = counted('SHOULD NOT BE READ');
  const b = await cacheAsideWith(cache, null, key, CACHE_TTL.reference, second.load, clock.now);
  assert.equal(a, 'from the database');
  assert.equal(b, 'from the database');
  assert.equal(second.calls(), 0, 'the second read is a hit on Redis');

  // The TTL rides on the SET, so Redis expires the entry itself.
  const set = sent.find((s) => s[0] === 'SET');
  assert.equal(set?.[3], 'EX');
  assert.equal(Number(set?.[4]), CACHE_TTL.reference);

  await cacheAsideWith(
    cache,
    null,
    cacheKeys.auditAreas(HASS),
    300,
    async () => 'areas',
    clock.now,
  );
  const removed = await cache.deleteNamespace(namespaceFor(HASS));
  assert.equal(removed, 2, 'a namespace flush works over SCAN and DEL');
  assert.equal(await cache.get(key), null);
});
