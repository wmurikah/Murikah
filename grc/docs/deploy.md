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

### Migration 004, per-organisation evidence storage connections

`grc/db/migrations/004-storage-connections.sql` (Build Prompt 51). It adds the
`storage_connections` table, which is how an organisation records where its
evidence is kept: Cloudflare R2, Google Drive, SharePoint/OneDrive or Dropbox,
with the credentials for that account sealed against that organisation.

- A plain `CREATE TABLE IF NOT EXISTS` with two indexes: no existing table is
  touched, nothing is copied, and running it twice changes nothing. It is
  therefore safe to apply before or after the release lands.
- Until an organisation configures a provider, evidence cannot be attached and
  the evidence panel says so. Evidence already stored keeps working: rows
  recording `backend = 'r2'` fall back to the platform's own bucket and rows
  recording `backend = 'drive'` to the platform's read-only Drive credential, so
  nothing that is already attached becomes unreadable by applying this.
- The credentials rest as one AES-GCM sealed blob in `config_sealed`, keyed off
  `GRC_SESSION_SECRET`, the same treatment the Outlook refresh token gets.
  **Rotating `GRC_SESSION_SECRET` makes every stored connection unreadable**, and
  each organisation must reconnect; that is the same consequence rotation
  already has for the mailbox.
- A partial unique index refuses two active connections for one organisation, so
  "which provider holds new evidence?" can never have two answers.

Afterwards, each organisation's administrator configures a provider on
`/settings/storage`: fill in the fields or Connect, test it, choose a folder,
then make it active. Registering the platform's own OAuth applications is a
one-time job documented in `grc/docs/storage-setup.md`.

### Migration 005, when information was requested and when it arrived

`grc/db/migrations/005-requirement-dates.sql` (Build Prompt 52). It adds
`requested_date` and `received_date` to `work_paper_requirements`, so a
requirement records not only what was asked for but when it was asked for and
when it arrived.

- Two plain `ADD COLUMN`s: no key change, no table rebuild, no data moves.
  Existing rows get NULL for both, which reads as "not yet received" and is the
  honest answer for a row that never recorded either.
- This is the same change the operator's own `grc-requirements-dates.sql` made.
  If that has already been applied, this run fails harmlessly with "duplicate
  column name" and nothing is altered. It is committed here so the columns are
  reproducible in a fresh database rather than a change only one database
  happens to carry.
- Independent of migrations 001 to 004 and applicable in any order relative to
  them. The code reads both columns, so apply it before or as the release
  deploys; if the deploy lands first, the Requirements section fails to load
  until it is applied.
- `status` keeps its meaning and the application keeps it in step with
  `received_date`, so a row reading `PENDING` or `OPEN` is still outstanding and
  nothing that reads the column has to change. The screen labels a requirement
  from the date rather than the column, so nothing needs back-filling.

The migration file carries the queries for what is still outstanding and for
turnaround on what has arrived.

### Migration 006, requirement owners, submissions and the review loop

`grc/db/migrations/006-requirements-workflow.sql` (Build Prompt 58). It creates
`requirement_owners` and `requirement_submissions`, and adds
`last_reviewed_date`, `closed_at` and `closed_by` to `work_paper_requirements`,
so a requirement records who owes it, what they provided in each round, what
audit decided on each round, and when the ask ended.

- Two `CREATE TABLE IF NOT EXISTS` and three plain `ADD COLUMN`s: no key change,
  no table rebuild, no data moves. Existing requirements get NULL for all three
  columns, which reads as "never reviewed, never closed" and is the honest
  answer for a row that predates the loop.
- This is the same change the operator's own `grc-requirements-workflow.sql`
  made. If that has already been applied, this run fails harmlessly with "table
  already exists" or "duplicate column name" and nothing is altered.
- Independent of migrations 001 to 005 in any order, except that it assumes 005
  has added the requirement dates. Apply it before or as the release deploys; if
  the deploy lands first, the Requirements module fails to load until it is
  applied. The Requirements section on a work paper is unaffected either way.
- A requirement received before this existed stays closed: the module derives its
  status from the close state and the rounds, and treats the older
  `received_date` as the ask having been answered, so nothing needs back-filling
  and no finished requirement reappears on an owner's list.
- Owners' uploads go to the organisation's own evidence store through the
  connector from migration 004, recorded in `files` and `file_attachments` under
  the `requirement` entity, so retention, legal hold and deletion already cover
  them.

The migration file carries the queries for what each owner still owes, the trail
for one requirement, and how long audit is taking to answer.

### Migration 007, the requirement round number

`grc/db/migrations/007-requirement-round-number.sql` (Build Prompt 61). It adds
`round_number` to `requirement_submissions` and numbers the rows already there,
per requirement, in submission order.

- **Apply this before or with the release.** Until it is applied, the
  requirements screens and `/api/sidebar-counts` fail with `no such column:
sub.round_number`.
- The operator's own `grc-requirements-workflow.sql` created the table without
  the column and ordered a requirement's rounds by `submitted_at`; migration 006
  created it with the column. The former is what was applied, so the two shapes
  drifted and the code shipped reading the half the database does not have. This
  reconciles them on the column, because a round is an ordinal quoted in
  correspondence as "round 2" and must not silently reorder itself when two
  rounds share a timestamp.
- One `ADD COLUMN` and one `UPDATE`: no key change, no table rebuild, nothing
  deleted. Running it twice is safe (the second run fails harmlessly with
  "duplicate column name", and the backfill is idempotent).
- The backfill numbers a row by how many rows of the same requirement were
  submitted no later than it, ties broken by `submission_id` so the numbering is
  total and repeatable.
- The reads tolerate a row that is not yet numbered (they fall back to
  `submitted_at`), so the window between deploying and applying this degrades in
  order rather than at random.

The migration file carries the verification queries: unnumbered rows, gaps and
repeats per requirement, and the trail as the screen reads it.

### The workflow enum, and why the smoke seed spells it in lower case

`status_transitions` keys every workflow in the product by `enum_type`, and more
than one of them defines a `Draft -> Submitted`: the work paper's
(`work_paper_status`) and the auditee response's (`response_status`). The live
database spells the work-paper workflow in lower case; the code spelled it in
upper case, so a case-sensitive lookup matched none of its rows, the engine
loaded an empty rule set, and every move a finding could make was refused with
"A move from Draft to Submitted is not permitted" (Build Prompt 61).

No migration is needed. The code now names the workflow as the database spells
it, every reference read is scoped to one enum and compares it whitespace and
case tolerantly, and a refused move logs the `enum_type` it searched beside the
`enum_type`s that do define the move, so the next mismatch of this kind explains
itself. The smoke seed mirrors the live shape, decoy row included.

## Storage provider secrets (never committed)

The OAuth providers need the platform's own application registration, which is
the same for every customer and so lives in Worker secrets. What is
per-organisation, and sealed in the database, is the refresh token naming the
customer's own account. Each is optional: an absent registration means that
provider is simply not offered, and `/settings/storage` says so rather than
showing a Connect button that would fail at the consent screen.

| Secret                     | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `GDRIVE_CLIENT_ID`         | Google Cloud OAuth client, for the Drive connector |
| `GDRIVE_CLIENT_SECRET`     | its secret                                         |
| `SHAREPOINT_CLIENT_ID`     | Microsoft Entra app, for SharePoint/OneDrive       |
| `SHAREPOINT_CLIENT_SECRET` | its secret (falls back to `GRAPH_CLIENT_*`)        |
| `DROPBOX_CLIENT_ID`        | Dropbox app, for the Dropbox connector             |
| `DROPBOX_CLIENT_SECRET`    | its secret                                         |

Cloudflare R2 needs no platform secret at all: an organisation supplies its own
account id, bucket and S3 keys on the settings screen. See
`grc/docs/storage-setup.md` for how to register each application and which
redirect URI to enter.
