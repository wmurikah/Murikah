# Hass CMS deploy notes

The Hass CMS is the third product in the one Murikah worker, served at
`cms.murikah.com`. Engineering Rhythm (`engr.murikah.com`) and the GRC platform
(`grc.murikah.com`) are unaffected: the worker (`src/worker.ts`) branches by host
and rewrites a cms-host request internally to the `/cms` route, so the app files
under `src/pages/cms/**` serve at the subdomain root with a clean browser URL.

## Custom domain

`cms.murikah.com` is a Cloudflare custom domain on the worker (already created).
No `routes` change is needed in `wrangler.jsonc`; the custom domain sends every
request for the host to the worker, which does the host branch.

## Runtime secrets (never committed)

Set these as Cloudflare Worker secrets in production, and in `.dev.vars` for local
development. The `getCmsEnv()` accessor throws a clear error when any is missing,
so the app fails loudly rather than running against the wrong database or an
unsigned session.

| Secret                   | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `TURSO_CMS_DATABASE_URL` | The live Hass CMS Turso (libSQL) database URL              |
| `TURSO_CMS_AUTH_TOKEN`   | The Turso auth token for that database                     |
| `CMS_SESSION_SECRET`     | 32+ random bytes, base64, signing the `cms_session` cookie |

The cookie is host-only and named `cms_session`, separate from engr's and grc's
cookies, so the three products never share a session.

## Ground truth and the typed layer

The full schema lives in the live CMS database, not the repo. `cms/db/schema.sql`
and `cms/db/schema.md` are a committed snapshot introspected from it; the typed
column layer `src/lib/cms/schema/columns.ts` is generated from the dictionary, so
a query naming a column that does not exist fails `pnpm build`, never at runtime.

- Regenerate the snapshot from the live database:
  `pnpm cms:db:introspect` (reads `TURSO_CMS_*` from `.dev.vars`).
- Regenerate the typed layer from the snapshot: `pnpm cms:db:columns`.

Commit the snapshot and the generated layer together.

## Tenancy and SaaS

The ported live schema is single-tenant and country-scoped. This port makes the
CMS multi-tenant with Hass as the first tenant; the tenant/plans/subscriptions
tables are added by `cms/db/migrations/010_tenancy.sql`, and each domain table
gains a `tenant_id` as its module is ported. Apply the migration to the live
database, then re-run the introspection so the typed layer picks up the new
tables and columns.
