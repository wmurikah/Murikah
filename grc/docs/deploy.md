# GRC platform: deploy and runtime configuration

The GRC platform is a second product in this repo, served at `grc.murikah.com`
by the same Cloudflare Worker that serves Engineering Rhythm and the marketing
site. It shares the tooling and the Murikah design system; its data, routes and
session are separate.

## How the worker routes by host

`src/worker.ts` decides the branch by host, before the Astro adapter resolves a
route:

- `grc.murikah.com` (and `*.grc.murikah.com`, and `grc.localhost` in dev): the
  GRC app, rewritten internally to the `/grc/*` routes under `src/pages/grc/**`.
- `engr.murikah.com`: Engineering Rhythm, unchanged.
- `murikah.com`: the marketing site; a stray `/grc` path is redirected to the
  subdomain, exactly as `/engr` is.
- `www.murikah.com`: redirected to the apex.
- any other host: a neutral 404.

The session guard for `/grc/*` runs in `src/middleware.ts`, separate from engr's.

## Runtime secrets (never committed)

Set these for local dev in `.dev.vars` (gitignored; see `.dev.vars.example`) and
in production as Cloudflare Worker secrets. They point at the `hassaudit`
database and sign the GRC session; they are distinct from engr's.

| Secret                   | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `TURSO_GRC_DATABASE_URL` | libSQL URL of the `hassaudit` database                     |
| `TURSO_GRC_AUTH_TOKEN`   | auth token for that database                               |
| `GRC_SESSION_SECRET`     | 32+ random bytes, base64 encoded; signs the session cookie |

Set them in production with:

```
wrangler secret put TURSO_GRC_DATABASE_URL
wrangler secret put TURSO_GRC_AUTH_TOKEN
wrangler secret put GRC_SESSION_SECRET
```

Generate a session secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The GRC env accessor (`src/lib/grc/env.ts`) throws a clear error at runtime if any
is missing, so the app fails loudly rather than running unconfigured. The
marketing preview typechecks without them (they are optional in the env types).

## Custom domain

The operator points the custom domain at the worker:

1. In the Cloudflare dashboard, add `grc.murikah.com` as a Custom Domain (or a
   route) for the worker that serves this project.
2. No code change is needed: the worker already recognises the host and serves
   the GRC app. Confirm on the deployed preview that `grc.murikah.com` shows the
   sign-in and that `engr.murikah.com` and `murikah.com` are unaffected. Every
   response carries `x-mrk-host` and `x-mrk-branch` (the grc branch is
   `grc-app`) so the routing is observable with a plain `curl`.

## Schema

The `hassaudit` schema is operator-managed and must not be changed from here.
The column names this foundation depends on are listed in
`grc/docs/schema-assumptions.md`, which is the single place to reconcile if any
differ from the live database.

## Migrations the operator runs

The `hassaudit` schema is operator-managed, so a schema change ships as a
committed SQL file under `grc/db/migrations/` and the operator applies it to
Turso. Each file carries its own reasoning and its own verification queries at
the foot; read the file before running it. The application never applies a
migration itself: nothing in the Worker issues DDL.

Apply one with the Turso shell, from a checkout at the merged commit:

```sh
turso db shell hassaudit .dump > backup-$(date +%Y%m%d).sql   # always, first
turso db shell hassaudit < grc/db/migrations/<file>.sql
```

Then run the verification queries the file lists and confirm the app still
signs in.

### Migration 001, tenant-scope the permission matrix

`grc/db/migrations/001-role-permissions-tenant-scope.sql` (Build Prompt 44,
audit finding AC-01). It adds `organization_id` to `role_permissions` so the
effective key becomes `(organization_id, role_code, module_code, action_code)`.
Until it runs, one customer's administrator rewrites every customer's roles with
a single save.

What it does, and what to expect:

- SQLite cannot add a column to a primary key in place, so it is a table
  rebuild: new table with the four-column key and the foreign keys, copy, drop,
  rename. It runs inside one transaction with `PRAGMA foreign_key_check` before
  the commit, so a copy that orphaned anything aborts rather than lands.
- **No grant is lost.** Every existing row is copied and assigned to the
  platform-default sentinel organisation `GLOBAL`, which is exactly what those
  rows already were: the defaults every organisation now inherits. Duplicate
  rows for the same cell, which the old table had no key to prevent, collapse to
  the permissive value, so nobody loses access they held.
- It creates the inactive `GLOBAL` sentinel organisation row if it is not
  already there (the same row the platform-wide config already uses). Inactive,
  so it never appears in an organisation list or the instance switcher.

**Order matters:** run this migration before or immediately as the release
deploys. The code reads `role_permissions.organization_id`, so on the old table
every matrix read fails and every non-SUPER_ADMIN user loses their grants until
it is applied. If the deploy lands first, apply the migration straight away and
the next request recovers, since nothing is cached.

Afterwards, every organisation resolves the platform defaults until an
administrator saves that organisation's own set on `/settings/access-control`.
A platform owner inside no instance edits the defaults themselves; inside an
instance, the same screen edits that instance's grants. New organisations are
given their own copy of the defaults at provisioning.

### Migration 002, confine a role to its affiliate

`grc/db/migrations/002-role-permissions-affiliate-scope.sql` (Build Prompt 45).
It adds `scope_to_affiliate` to `role_permissions`, so a role can be marked
confined to its user's affiliate.

- A plain `ADD COLUMN`: no key change, so no table rebuild and no data moves.
- Existing rows default to `0`, which is exactly the current behaviour, so
  applying it changes nothing anybody sees until an administrator ticks the box
  on `/settings/access-control`.
- Run migration 001 first: this assumes the tenant-scoped table it created.
  Running this one twice fails harmlessly with "duplicate column name".

Because it is a pure addition with a safe default, the ordering worry that
applies to migration 001 does not apply here. The code reads the column, so
apply it before or as the release deploys; if the deploy lands first, the reads
fail until it is applied.

Before confining a role, check that its users actually carry an affiliate. A
user in a confined role with no `users.affiliate_code` sees nothing at all until
one is assigned, which the screens say plainly rather than showing an empty
list. The migration file carries the query.

### Migration 003, the Group affiliate sees all affiliates

`grc/db/migrations/003-affiliate-is-group.sql` (Build Prompt 48). It adds
`is_group` to `affiliates`. A user posted to an affiliate marked as the Group is
exempt from affiliate confinement and sees every affiliate's records, within the
grants their role already holds.

- A plain `ADD COLUMN` with `NOT NULL DEFAULT 0`: no key change, no table
  rebuild, no data moves. Existing rows default to off, so applying it changes
  nothing until an administrator ticks the box on `/settings/affiliates`.
- This is the same change the operator's own `grc-group-affiliate.sql` made. If
  that has already been applied to the live database, this run fails harmlessly
  with "duplicate column name" and nothing is altered. It is committed here so
  the column is reproducible in a fresh database rather than a change only one
  database happens to carry.
- Independent of migrations 001 and 002: it touches a different table and can be
  applied in any order relative to them.

After applying it, mark the Group unit on `/settings/affiliates`. The screen
lists which affiliates confer all-affiliate access, so the answer to "why can
this person see every affiliate?" is a row on a page. The migration file carries
the queries for reading the same thing from the database.
