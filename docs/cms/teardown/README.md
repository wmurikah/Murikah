# CMS database teardown

Three files, run in order, in the Turso web console, by hand, by the operator.
Nothing in this repository executes them and no automation runs them. They exist
so the destruction is deliberate, reviewable and reversible right up to the
moment the last one is run.

Run them **after** the pull request is merged, not before. Until then the
holding page at `cms.murikah.com` does not touch the database at all, so there
is no hurry and no window where a live app is querying tables that have gone.

## Read this first

**The database is preserved on purpose. Do not drop it. Do not rename it. Do
not recreate it. Do not rotate, rename or remove its credentials.**

The redesign reconnects to the same database, at the same URL, with the same
token, through the same worker secret names:

| Secret                   | Preserved? |
| ------------------------ | ---------- |
| `TURSO_CMS_DATABASE_URL` | Yes        |
| `TURSO_CMS_AUTH_TOKEN`   | Yes        |
| `CMS_SESSION_SECRET`     | Yes        |

Recreating the database would mean re-issuing credentials and re-setting those
worker secrets for no gain whatsoever. Only the contents go. The container
stays.

The same applies on the Cloudflare side: the `murikah-web` worker, the
`cms.murikah.com` custom domain and its DNS records, and every entry in
`wrangler.jsonc` are untouched by this teardown and must stay that way.

## Before you start

Read the value of `TURSO_CMS_DATABASE_URL` and open **that** database in the
Turso console. Every product in this estate has its own database and the names
rhyme:

| Product            | Secrets        | Do not run this teardown against it |
| ------------------ | -------------- | ----------------------------------- |
| CMS                | `TURSO_CMS_*`  | This is the target                  |
| GRC platform       | `TURSO_GRC_*`  | Correct, leave alone (`hassaudit`)  |
| Engineering Rhythm | `TURSO_ENGR_*` | Correct, leave alone                |
| Marketing site     | `TURSO_*`      | Correct, leave alone                |

If you are unsure which one is open, step 1 tells you.

## Step 1: `00_inventory.sql`

Confirms the target and shows the scale of what is about to go. Writes nothing.

**A correct result** is a list of objects whose table names are the CMS ones:
`customers`, `contacts`, `tickets`, `orders`, `invoices`, `segments`,
`retention_activities` and so on, roughly 64 tables and 65 indexes, with no
views and no triggers. The counts query should agree. The row counts at the end
tell you how much customer data is about to be destroyed.

**Stop immediately** if you instead see:

- `work_papers`, `action_plans` or `organizations`: this is the GRC database.
- `work_orders`, `rfqs` or `job_cards`: this is the Engineering Rhythm database.
- `leads`, `subscribers` or `demo_sessions`: this is the marketing database.

Close it, open the right one, and start again.

## Step 2: `01_dump_schema_note.md`

Not a script. Read it, or simply satisfy yourself that it is committed on the
branch you are merging. It preserves the full DDL in readable form so the old
structure survives the drop.

**A correct result** is that the object list you saw in step 1 matches the
tables listed in this file. If step 1 showed an object this file does not
mention, the live database drifted from the snapshot: note the extra object
before you continue, because step 3 will not name it and you will have to drop
it by hand.

## Step 3: `02_drop_all.sql`

Drops every CMS object. There is no database-level destructive statement in it,
and there must never be one. Every statement uses `IF EXISTS`, so the file is
safe to re-run.

The drops are ordered children before parents, and the file switches foreign key
enforcement off around the block and back on at the end. It has been verified
against the archived schema with foreign keys enforced, twice in succession, and
leaves the database completely empty both times. If your console rejects
`PRAGMA` statements, delete the two `PRAGMA` lines and run the rest as it
stands; the ordering carries the file on its own.

**A correct result** is that the proof query at the end of the file, which is
the same query as step 1, returns **no rows**. That empty result is the whole
point of the exercise: the database still exists, still answers, and now holds
nothing.

If the proof query returns rows, the live database held an object the snapshot
did not know about. Copy each remaining name into a `DROP TABLE IF EXISTS`,
`DROP VIEW IF EXISTS` or `DROP TRIGGER IF EXISTS` of its own and run the file
again until the proof query is empty.

## Afterwards

Nothing else is required. Do not re-run any migration, do not re-seed, do not
re-create a schema. The next build prompt designs the CMS from nothing and will
bring its own schema. An empty database is exactly the state it expects to find.
