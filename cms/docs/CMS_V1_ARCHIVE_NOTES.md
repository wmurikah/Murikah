# CMS v1 archive notes

Written on the working branch immediately before the clean-slate teardown, so
the redesign can be built against facts rather than guesses. Everything
described here was deleted in the same pull request. The code itself is
recoverable from the archive branch `archive/crm-v1-pre-teardown` (commit
`5698d25f956539d1dd3e3ed3aa9ce35d91b8da52`).

## A note on the name

The build prompt for this teardown calls the product "the CRM" and expects it
under `crm/` on `crm.murikah.com`. No `crm/` path has ever existed in this
repository, on any branch or in any commit. The third product alongside
Engineering Rhythm and the GRC platform is the **Hass CMS**, under `cms/` and
`src/**/cms/**`, served at **cms.murikah.com**. Its domain is customer
relationship management in all but name: customers, contacts, segments,
tickets, SLAs, churn risk, retention activities, orders, invoices and a
customer portal. This document therefore records the Hass CMS, and every
reference to "the CRM" in the teardown prompt should be read as the Hass CMS.

## Route paths served

The app files lived under `src/pages/cms/**`. The worker rewrote a cms-host
request internally to the `/cms` route, so the visitor saw the root-relative
path with no `/cms` prefix. Both forms are listed because the redesign has to
reproduce the same mapping.

| Visitor path on cms.murikah.com | Internal route file             |
| ------------------------------- | ------------------------------- |
| `/`                             | `src/pages/cms/index.astro`     |
| `/login`                        | `src/pages/cms/login.astro`     |
| `/mfa`                          | `src/pages/cms/mfa.astro`       |
| `/portal`                       | `src/pages/cms/portal/index.astro` |
| `/portal/login`                 | `src/pages/cms/portal/login.astro` |
| `/api/auth/login`               | `src/pages/cms/api/auth/login.ts`  |
| `/api/auth/logout`              | `src/pages/cms/api/auth/logout.ts` |
| `/api/auth/mfa`                 | `src/pages/cms/api/auth/mfa.ts`    |

Public, unauthenticated paths (`PUBLIC_CMS_PATHS` in `src/lib/cms/routing.ts`)
were `/login`, `/portal/login`, `/api/auth/login`, `/mfa` and `/api/auth/mfa`.
Everything else required a verified session. `/api` and anything under it was
treated as an API path and answered 401 JSON rather than redirecting.
`/portal` and anything under it was the customer surface; staff users were kept
out of it and customer users were confined to it.

## Hostname and routing

- Production host: **cms.murikah.com**, plus any sub-label of it (reserved for a
  future per-tenant subdomain).
- Local development hosts: `cms.localhost` and `*.cms.localhost`.
- The host branch lived in `src/worker.ts` (`isCmsHost`), which rewrote to the
  internal `/cms` route via `toCmsPath` and left the browser URL clean. Static
  assets and Astro infra routes (`/_*` and anything with a file extension)
  passed through unrewritten via `isCmsPassthroughAsset`.
- On the marketing apex, a `/cms` path was redirected to the subdomain by
  `cmsMarketingRedirect`, mirroring how `/engr` and `/grc` paths are handled.
- Every response carried the debug headers `x-mrk-host` and `x-mrk-branch`, the
  latter set to `cms-app` on this branch.
- `cms.murikah.com` is a Cloudflare custom domain on the `murikah-web` worker,
  configured in the Cloudflare dashboard. There is no `routes` entry for it in
  `wrangler.jsonc` and none is needed.

## Environment variables and worker secrets

Read through `cloudflare:workers` env by `getCmsEnv()` in `src/lib/cms/env.ts`.
**These names are reserved and must be reused by the redesign rather than
replaced.** The values behind them are unchanged by this teardown.

| Name                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `TURSO_CMS_DATABASE_URL` | The Turso (libSQL) database URL for the CMS database  |
| `TURSO_CMS_AUTH_TOKEN`   | The Turso auth token for that database                |
| `CMS_SESSION_SECRET`     | 32+ random bytes, base64, signing the session cookie  |

They are declared as optional on the `Env` interface in `src/env.d.ts` so a
marketing-only preview typechecks without them; the accessor threw a clear error
at runtime when any was missing. The declarations are kept in place by this
teardown.

The session cookie was named `cms_session`, host-only, separate from the engr
and grc cookies so the three products never shared a session.

No `wrangler.jsonc` binding, var, route, cron or asset entry was specific to the
CMS. `.dev.vars.example` never listed the `TURSO_CMS_*` or `CMS_SESSION_SECRET`
entries, so a developer had to take them from `cms/docs/deploy.md`. The redesign
should add them to `.dev.vars.example`.

## Turso database

The CMS owned its database outright. It was not shared with any other product:
Engineering Rhythm reads `TURSO_ENGR_*`, the GRC platform reads `TURSO_GRC_*`
(database `hassaudit`), and the marketing site reads the unprefixed `TURSO_*`
(tables `leads`, `subscribers`, `demo_sessions`). No CMS table name collides
with a marketing table name.

The database name itself is not recorded anywhere in the repository. It lives
only in the value of the `TURSO_CMS_DATABASE_URL` worker secret, which this
teardown deliberately leaves in place. The operator must read that secret to
confirm which database the teardown SQL is pointed at before running it.

### Tables (64)

Introspected from the live database on 2026-07-07 and committed as
`cms/db/schema.sql` and `cms/db/schema.md`. Full column lists are preserved in
`cms/db/teardown/01_dump_schema_note.md`.

```
approval_requests      approval_workflows   audit_log             bot_conversations
bot_llm_configs        bot_tools            branding              business_hours
churn_risk_factors     config               contacts              countries
customers              delivery_locations   depots                documents
drivers                entity_statuses      escalation_paths      exchange_rates
holidays               integration_log      invoices              job_queue
knowledge_articles     knowledge_categories localization          menu_items
mfa_challenges         notification_preferences                   notification_templates
notifications          order_lines          order_status_history  orders
password_history       password_resets      payment_uploads       permissions
po_approvals           po_so_comments       price_list            price_list_items
products               recurring_schedule   recurring_schedule_lines
retention_activities   role_permissions     roles                 segments
sessions               signup_requests      sla_config            so_approvals
staff_messages         status_transitions   teams                 ticket_attachments
ticket_comments        ticket_history       tickets               user_roles
users                  vehicles
```

### Views, triggers and virtual tables

None. The committed snapshot contains no `CREATE VIEW` and no `CREATE TRIGGER`,
and its header records that no FTS shadow tables exist in this database.

### Indexes (64)

All are named `ix_*` and are listed in `cms/db/schema.sql`. Every one is
attached to a table above, so dropping the tables drops them; the teardown
script does not name them separately.

### Migration not reflected in the snapshot

`cms/db/migrations/010_tenancy.sql` added a multi-tenant layer (`tenants`,
`plans`, `tenant_subscriptions`, index `ix_tenant_sub_tenant`) with Hass as the
first tenant. Those three tables do not appear in the 2026-07-07 snapshot, so it
is not certain the migration was ever applied to the live database. The teardown
script drops them with `IF EXISTS`, so it is correct either way.

## File tree as it stood

Product directory:

```
cms/
  db/
    gen-columns.mjs               generated the typed column layer from schema.md
    introspect.mjs                regenerated the snapshot from the live database
    migrations/010_tenancy.sql    multi-tenant SaaS layer
    schema.md                     ground-truth column dictionary
    schema.sql                    ground-truth DDL snapshot
  docs/
    deploy.md                     host, secrets, ground truth, tenancy
  test/
    routing.test.ts               host branch and path mapping
    totp.test.ts                  RFC 6238 vectors
```

Application code elsewhere in the repository:

```
src/lib/cms/
  auth/password.ts                re-exported Engineering Rhythm's hasher
  auth/rbac.ts                    role_permissions loader and can()
  auth/session.ts                 signed cms_session cookie read and write
  auth/totp.ts                    RFC 6238 core (KEPT, see below)
  db.ts                           libSQL client factory
  env.ts                          getCmsEnv()
  repos/authUsers.ts              staff and customer credential lookups
  repos/branding.ts               country-scoped branding, DEFAULT_BRANDING
  repos/session.ts                session resolve, touch, display identity
  routing.ts                      host and path routing (KEPT, see below)
  schema/columns.ts               generated typed column layer
  tenancy.ts                      role to tenant resolution
src/pages/cms/
  index.astro                     staff dashboard
  login.astro                     staff sign-in
  mfa.astro                       TOTP step
  portal/index.astro              customer portal home
  portal/login.astro              customer portal sign-in
  api/auth/login.ts               sign-in endpoint
  api/auth/logout.ts              sign-out endpoint
  api/auth/mfa.ts                 TOTP verification endpoint
src/layouts/
  CmsLayout.astro                 staff shell
  CmsAuthLayout.astro             two-pane sign-in shell
  CmsPortalLayout.astro           customer portal shell
src/components/cms/
  CmsError.astro                  branded error card
src/styles/
  cms.css                         product stylesheet, 380 lines
```

## What was deliberately kept, and why

Two modules under `src/lib/cms/` survive the teardown because code outside the
CMS depends on them. Neither was modified.

- **`src/lib/cms/routing.ts`** is imported by `src/worker.ts` for `isCmsHost`,
  `toCmsPath`, `isCmsPassthroughAsset` and `cmsMarketingRedirect`. It is the
  host branch the teardown is required to preserve, so that cms.murikah.com
  keeps resolving with no Cloudflare reconfiguration.
- **`src/lib/cms/auth/totp.ts`** is the RFC 6238 core. The GRC platform
  re-exports it verbatim from `src/lib/grc/auth/totp.ts`, and two GRC tests
  (`grc/test/loginSecurity.test.ts`, `grc/test/smoke.test.ts`) import it
  directly. It is a pure, import-free leaf module. Deleting it would break the
  GRC platform, which is fenced, so it stays exactly where it is and
  `cms/test/totp.test.ts` stays with it to keep its coverage.

The redesign should decide whether to promote `auth/totp.ts` to a shared path.
Doing so means editing GRC files, which was out of scope for the teardown.

## Shared code the CMS used

Left untouched by the teardown. The redesign is expected to reuse it.

- `@engr/auth/password`, the Engineering Rhythm password hasher, re-exported by
  `src/lib/cms/auth/password.ts`.
- `@/styles/global.css` and, through it, `@/styles/tokens.css`, the Murikah
  design tokens (navy, brass, ivory, the type scale).
- `@libsql/client/web`, the Workers-compatible libSQL build, and the
  per-request client pattern with `PRAGMA foreign_keys = ON`.
- `astro:middleware` and the `cloudflare:workers` env module.

No dependency in `package.json` was used only by the CMS. `uqr` belongs to GRC,
`jose` to engr and GRC, `@libsql/client` to all three products and the
marketing site.

## Product conventions worth carrying forward

Recorded because they are properties of the live database, which survives in
name and credentials even though its contents do not.

- Natural primary keys throughout (`user_id`, `session_id`, `ticket_id`), text,
  not integers.
- Timestamps are text, `datetime('now')` defaults, UTC.
- Two user types, `STAFF` and `CUSTOMER`, held in separate tables (`users` and
  `contacts`) with one shared `sessions` table discriminated by `user_type`.
- Country scoping (`country_code`) on nearly every domain table, with `countries`
  as the root reference table.
- Booleans are integers, 0 or 1, with `NOT NULL DEFAULT`.
- The typed column layer was generated from the schema dictionary rather than
  hand-written, so a query naming a column that does not exist failed the build
  rather than a request.
