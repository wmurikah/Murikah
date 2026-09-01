# Cloudflare performance recommendations (advisory only)

**Nothing in this document has been applied.** Phase 5 was built under an
absolute Cloudflare and deployment freeze: no Worker settings, routes, build
or deploy commands, wrangler configuration, bindings, cache rules or
environment variables were changed, and none of the recommendations below may
be applied as a side effect of a code deployment. Each is a deliberate,
human-approved operations change, listed here with its rationale, its steps
and its revert.

## 1. Smart Placement — worth evaluating

**Why.** The CMS Worker talks to Turso over HTTP on every request, several
round trips per page even after batching. If the database's primary region is
far from the visitor's edge location, every round trip pays that distance.
Smart Placement lets Cloudflare run the Worker near its back-end (the
database) rather than near the visitor, converting N long round trips plus
one short one into one long round trip plus N short ones — usually a
substantial win for a database-chatty, server-rendered application like this
one.

**How (when approved, by a human, in the dashboard or wrangler):** set
`placement = { mode = "smart" }` for the Worker (dashboard: Settings →
Placement). Measure a week of `Server-Timing`/`[cms.perf]` figures before and
after; Smart Placement observes traffic before it moves anything, so give it
time.

**Revert:** set placement mode back to default/off. No code change either way.

**Caution:** static assets and the marketing site are unaffected (served from
the edge regardless), but any latency-sensitive integration other than Turso
(OIDC providers, AI providers) will now be called from the placed location.
Check their timings in the same measurements.

## 2. Workers Logs — turn on retention and read `[cms.perf]`

**Why.** The middleware logs one structured line for any CMS request slower
than 750 ms: `[cms.perf] path=/app total=812 auth=41 page=771`. With Workers
Logs enabled (dashboard: Worker → Logs), those lines become a queryable
record of where slow requests spend their time, with no APM vendor and no
code change. Filter on `[cms.perf]`; the `path` is the route only — the line
never carries query strings, SQL, identifiers or tokens, so retention is
safe.

**Revert:** disable Workers Logs; the lines still go to `wrangler tail`.

## 3. Static assets — keep the defaults, they are already right

The build already emits immutable, content-hashed assets and the adapter
injects `Cache-Control: immutable` for `/_astro/*` into `_headers`. No Cache
Rule is needed for these; do not add one.

## 4. Never cache authenticated HTML

Do **not** create a "Cache Everything" rule (or any page-cache rule) that
covers `cms.murikah.com` paths. Every authenticated response is per-user —
per-permission navigation, per-user notification state, CSRF-relevant
markup — and the middleware marks it `cache-control: no-store`. An edge cache
rule that overrode that would serve one user's page to another. Perceived
performance for authenticated pages comes from the application work in this
phase, not from edge caching.

## 5. Hyperdrive — not appropriate here

Hyperdrive pools and accelerates connections to **PostgreSQL/MySQL-protocol**
databases. This application uses Turso (libSQL) over its own HTTP protocol,
which Hyperdrive does not speak, and `@libsql/client/web` is already
connectionless per request. There is nothing for Hyperdrive to pool.
Recommendation: do not adopt; revisit only if the database platform itself
changes.

## 6. If Turso latency remains the ceiling

After Smart Placement, the remaining lever is data placement: Turso replicas
in the region(s) Cloudflare places the Worker. That is a database-platform
decision (cost, consistency for the write path) and out of scope for this
codebase; the `db` spans in `Server-Timing` are the measurement to justify
it.
