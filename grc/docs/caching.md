# Caching (Build Prompt 42)

Hot reads are served cache-aside so the platform stays fast at scale. Nothing
here is allowed to cost correctness: no user is ever shown data they could act
on wrongly, tenancy is untouched, and an access change still takes effect on the
very next request.

Code lives in `src/lib/grc/cache/`.

## The two layers

**Per-request memo (in-isolate).** Repeated identical reads inside a single
request are deduped in a `Map` that is discarded when the request ends. The map
hangs off the libSQL client in a `WeakMap`, and that client is created fresh per
request (`src/lib/grc/db.ts`), so the memo cannot outlive a request and cannot be
shared between two of them: there is no module-level map to leak. The in-flight
promise is memoised rather than the resolved value, so concurrent identical reads
collapse into one query.

**Shared cache (cross-request).** A four-method interface, `GrcCache`:

```ts
get(key): Promise<string | null>
set(key, value, ttlSeconds): Promise<void>
delete(key): Promise<void>
deleteNamespace(prefix): Promise<number>
```

On read: check the cache; on a miss read the database and populate with a TTL. On
write: invalidate the affected keys immediately.

## Backends

Resolved once per isolate in `cache/index.ts`, never at a call site:

1. **Upstash Redis over HTTP** when `GRC_CACHE_REDIS_URL` and
   `GRC_CACHE_REDIS_TOKEN` are set (`cache/upstash.ts`).
2. **Cloudflare KV**, the default, bound as `GRC_CACHE` (or the existing `CACHE`
   namespace) (`cache/kv.ts`). A Worker cannot run a Redis server in-process, so
   the native edge cache is what ships.
3. **In-isolate memory** when nothing is bound (`cache/memory.ts`): local
   development, and the Cloudflare preview, which deploys with no pre-created
   resources.

### Swapping KV for Upstash Redis

No call site changes. In an environment that has an Upstash database:

```
wrangler secret put GRC_CACHE_REDIS_URL     # https://<db>.upstash.io
wrangler secret put GRC_CACHE_REDIS_TOKEN   # the REST token
```

The next isolate to start picks Redis over KV. Rolling back is deleting the two
secrets. `grc/test/cache.test.ts` drives the Upstash adapter through the same
cache-aside core as the KV default, with a stubbed `fetch`, so the contract is
proven rather than assumed.

### Enabling the KV default

The preview deploys with no Cloudflare resources, matching how the rate limiter
and the evidence bucket are handled on this repository: the binding is documented
and commented out, and the code degrades. To turn it on:

```
wrangler kv namespace create GRC_CACHE
```

then add the binding to `wrangler.jsonc` with the returned id. Until then the
memory fallback runs and the app is correct, simply with less caching (see the
clamp below).

### The `shared` flag

`GrcCache` reports whether its entries are visible across isolates. It is false
only for the memory fallback, and `cache/core.ts` clamps every lifetime to
`LOCAL_MAX_TTL_SECONDS` (10 seconds) when it is: an invalidation in one isolate
cannot reach another, so only a short lifetime bounds the staleness.

### The envelope

Every value is wrapped as `{ v, e }` where `e` is an absolute expiry, and the
expiry is enforced on read (`cache/envelope.ts`). Cloudflare KV floors
`expirationTtl` at 60 seconds, so without this the permission matrix could not
have a 5 second lifetime at all. The backend TTL becomes an eviction hint; the
envelope is the truth. A malformed or expired envelope reads as a miss.

## What is cached

| Read                                                           | Key                      | TTL  |
| -------------------------------------------------------------- | ------------------------ | ---- |
| Audit areas, sub-areas (`repos/auditUniverse.ts`)              | `audit-universe:*`       | 300s |
| Work-paper lookups (`repos/workPaperLookups.ts`)               | `lookups:*`              | 300s |
| Affiliates (`repos/affiliatesAdmin.ts`)                        | `affiliates:*`           | 300s |
| `DROPDOWN_*` vocabularies (`repos/dropdowns.ts`)               | `dropdown:*`             | 300s |
| General settings (`repos/orgConfig.ts`, allow-listed keys)     | `config:*`               | 300s |
| Subscription and plan flags (`repos/features.ts`)              | `subscription`           | 300s |
| Enum display labels (`repos/enums.ts`)                         | platform `enum-labels:*` | 300s |
| Dashboard stats, charts, sidebar counts (`repos/dashboard.ts`) | `dashboard:*`            | 60s  |
| Permission matrix per role (`auth/rbac.ts`)                    | platform `role-matrix:*` | 5s   |

The dashboard aggregations are the expensive ones and are the reason the short
window exists: a count that is a few seconds behind is not a count anyone acts on
wrongly, and every work-paper and action-plan mutation clears them anyway.

## What is never cached

- **The session, its validity, and the user's identity.** `repos/session.ts` is
  read from the database on every single request, beyond the per-request memo.
  A revoked session must stop working at once, and a cached identity is a cached
  authorisation decision.
- **MFA records.** They live in the same `config` table as the general settings,
  which is why `getConfigValues` caches on an **allow-list** and not a
  deny-list: only `SETTINGS_KEYS` and the `DROPDOWN_*` vocabularies are cached,
  and everything else reads fresh. A new config key is uncached until someone
  deliberately lists it. Config entries are keyed by the whole set of keys a
  caller asked for, so a miss stays one batched query, and any config write
  clears the organisation's whole config namespace rather than reasoning about
  which combinations held the key.
- **Work paper and action plan rows.** These are what a user acts on. Only the
  counts derived from them are cached.
- **The assignable-auditor list.** Derived from `users`, where a status change
  should be visible at once.

## Tenancy

Every tenant key begins with the acting `organization_id`, and each segment is
percent-encoded so an identifier containing a colon cannot forge its way into a
neighbouring namespace. The namespace is a convenience for flushing and never an
authority: the acting organisation is still resolved and verified from the
session in `src/middleware.ts` on every request, and every repo is still called
with that verified id. A cache entry cannot widen anybody's access, because the
key it lives under is derived from an id the server already proved.

An empty organisation id (a platform owner who has entered no instance) yields
the empty key, which the core treats as "not cacheable" and passes straight to
the database. No instance means no cached entry.

Platform reference data that belongs to no tenant, the role matrix and the enum
labels, sits under the reserved `GLOBAL` namespace, the same sentinel the config
table already uses. Nothing tenant-derived is placed there.

## Immediacy of access changes

The permission matrix is the one place speed comes near access control, and it is
fenced on both sides:

1. **Explicit invalidation first.** `repos/permissionsAdmin.ts::setGrant`
   invalidates the role's cached matrix inside the write itself, so no write path
   can leave a changed grant cached. `/api/access-control` clears it again once
   the whole submission lands. The change is in force on the very next request,
   not at the next sign-in.
2. **A capped TTL as the backstop.** A Cloudflare KV delete is not instantaneous
   at every edge, so `CACHE_TTL.roleMatrix` is 5 seconds. Even at an edge the
   delete has not reached, a stale matrix cannot outlive it.

A _user's_ role change needs no invalidation at all: `users.role_code` arrives
with the identity, which is never cached.

## Invalidation

Keys are named in `cache/keys.ts` and cleared in `cache/invalidate.ts`, and
nowhere else. Each repo mutation calls the invalidator for its own domain, from
inside the write rather than beside it, so adding a new write path means calling
an existing invalidator instead of inventing one. The bias is deliberate: when a
change could plausibly touch a derived entry, clear it. Editing an audit area
clears the universe, the form lookups and the dashboard charts (which group by
area). Over-invalidating costs one database read.

## Observability and recovery

`/platform/cache` (platform owner only) shows the backend in use, the hit rate,
and the counters both rolled up across isolates and for the isolate serving the
request. `/api/platform/cache` serves the same as JSON on `GET`, and takes
`op=flush` with an `organization_id`, or `op=reset` for the counters, on `POST`.

Counters live in the isolate that did the work, so each isolate folds its
unreported delta into one of eight fixed shard keys in the shared cache, and the
screen sums the shards. A fixed shard count keeps this inside the four-method
contract: no key enumeration is needed to read the totals. The roll-up is best
effort by design, runs through `waitUntil` where the platform offers one, and is
throttled to one write per isolate per ten seconds. An approximate hit rate is
worth as much as an exact one, and diagnostics must never cost a user latency.

The shard keys sit outside the `grc:v1:` root, so flushing an organisation never
disturbs them.

## Tests

`grc/test/cache.test.ts` covers hit, miss, in-request dedupe, expiry by envelope,
key tenancy (including the colon-forging case and the no-instance case), key and
prefix invalidation, the organisation flush, the local-cache clamp, the Upstash
adapter over a stubbed `fetch`, and that a `role_permissions` change is reflected
on the very next read, both by explicit invalidation and by the TTL cap alone.
