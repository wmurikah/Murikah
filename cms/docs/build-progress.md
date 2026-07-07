# Hass CMS build progress (resumable checkpoint)

This file is the resumable checkpoint for the module build (Build Prompt 02). Each
phase is small, committed, and green before the next; a run that is interrupted
resumes from the first incomplete phase rather than restarting. Update this after
every phase.

Status key: `done` (built to the standards and green), `in progress`, `pending`,
`blocked` (needs an external input, noted).

## Foundation (Build Prompt 01)

- [x] Ground-truth typed layer from the live schema (`cms/db/schema.sql`,
      `cms/db/schema.md`, `src/lib/cms/schema/columns.ts`, 64 tables).
- [x] Host routing (`cms.murikah.com`), env/db factories, deploy docs.
- [x] Auth: two user types, DB-backed sessions, RFC 6238 TOTP MFA.
- [x] RBAC `can(...)`, per-tenant branding, staff and portal shells.
- [x] Per-route error boundary (`CmsError`).

## Seeded non-production database (no production credentials)

Per direction, the build runs against a seeded non-production database, never the
production `TURSO_CMS_*`. Tooling (a build-time dev tool, ships nothing):

- `pnpm cms:db:apply` applies `cms/db/schema.sql` and `cms/db/migrations/*.sql` to
  `CMS_DB_URL` (default a local libSQL file `cms/.data/staging.db`, gitignored; or
  a staging Turso URL via `CMS_DB_URL` + `CMS_DB_AUTH_TOKEN`).
- `pnpm cms:db:seed` seeds deterministic demo data (ported and extended from
  `99_dev_seed.gs`). Demo sign-in: `admin@hasspetroleum.com` / `HassDemo1!`
  (staff) and `achieng@nairobilogistics.co.ke` / `HassDemo1!` (portal). These are
  non-production demo credentials.
- `cms/test/smoke.test.ts` is the data-layer smoke: it runs in `pnpm test`
  against the seeded database (skips cleanly when none is present, so CI stays
  honest), certifying the core reads and both sign-ins per phase.

Two things still need a **staging Turso HTTP endpoint** (the Worker `@libsql/web`
build cannot open a local `file:` URL, and no local `sqld` is available): the
app-level smoke crawl (sign in and GET every page) and the 60-second real-app
video. The seed and migrations apply to that endpoint with the same tooling.

- **Tenancy on domain tables**: the live domain tables have no `tenant_id` yet
  (the source is single-tenant). Modules scope within the Hass tenant by the
  existing columns (`country_code` for staff visibility, `customer_id` for the
  portal); each table gains `tenant_id` via a migration as a second tenant lands,
  regenerating the typed layer. The tenant_id retrofit is one migration on the
  seeded database.

## Phases (Build Prompt 02, section 4)

1. [in progress] Customers and contacts (read surface built and smoke-certified
   against the seeded DB: list, detail, contacts, RBAC gate, error boundary. Write
   CRUD, balances, self-signup and KYC fields next.)
2. [in progress] Catalog, pricing and bundles (read surface built and
   smoke-certified against the seeded DB: staff catalogue with search + category
   filter, product detail with its price across every price list, a price-lists
   overview with per-list product counts, RBAC gate `catalog.view`, error
   boundary. Seed a default price list per country (KE/UG) pricing every
   product. Bundles, write CRUD and effective-date pricing next.)
3. [in progress] Orders and approvals (read surface built and smoke-certified
   against the seeded DB: staff list with search + status, order detail with
   lines, portal orders scoped to the signed-in customer, RBAC gate
   `orders.view`, error boundary. Write CRUD, approvals and Oracle approvals
   next.)
4. [in progress] Invoices and ETIMS (read surface built and smoke-certified
   against the seeded DB: staff list with search + status, invoice detail with
   the ETIMS block and the parent order's lines, portal invoices scoped to the
   signed-in customer, RBAC gate `invoices.view`, error boundary. Seed invoices
   the approved/fulfilled orders; paid ones carry an ETIMS submission. Write
   CRUD, ETIMS submission and credit notes next.)
5. [in progress] Payments (M-Pesa, bank, Oracle receipts) (read surface built
   and smoke-certified against the seeded DB: staff review list with search +
   status, payment detail with the proof metadata, matched invoice and review
   status, portal payments scoped to the signed-in customer, RBAC gate
   `payments.view`, error boundary. Seed receipts match invoices; paid ones are
   approved with a reviewer, partial ones pending. Approve/reject write actions
   and M-Pesa STK reconciliation next.)
6. [pending] Delivery locations and documents
7. [in progress] Tickets, SLA and knowledge (read surface built and
   smoke-certified against the seeded DB: staff list with search + priority
   filter, ticket detail with the comment thread including internal notes,
   portal tickets scoped to the signed-in customer with internal comments
   hidden, RBAC gate `tickets.view`, error boundary. Priority honours the
   CHECK. SLA timers, assignment, knowledge base and write actions next.)
8. [pending] Omnichannel intake and notifications
9. [pending] AI bot
10. [in progress] Reports and analytics (customer and sales analytics built and
    smoke-certified against the seeded DB: customer summary tiles and charts by
    country/type/status plus top accounts; a sales section with revenue by
    month, the order funnel, the invoice payment mix and the payment-method mix,
    over the seeded transactional data. Ticket SLA analytics and exports follow.)
11. [in progress] Customer portal (the portal home shows the signed-in
    customer's own account and contacts, scoped to their customer_id, and links
    to their orders, invoices, payments and support tickets (all same scope;
    internal ticket notes hidden), error boundaried. Self-service order
    placement and payment submission are the next writes.)
12. [pending] Admin and config
13. [pending] Oracle mirror and integrations wiring

## App-level crawl and the overview video (staged, awaiting staging Turso)

The app-level crawl and the 60-second video both need a running CMS app pointed
at the seeded staging database (the Worker `@libsql/client/web` build cannot open
a local `file:` database, so a staging Turso HTTP endpoint is required) and the
`playwright` package. Both are **staged and ready**; execution awaits the staging
endpoint. What is built:

- `cms/scripts/routes.mjs` — the canonical route manifest (every page, its file
  and auth context), the search dry-runs and the 60s storyboard: the single
  source of truth for the crawl, the recorder and the coverage test.
- `cms/scripts/crawl.mjs` (`pnpm cms:crawl`) — signs in as staff and as the
  portal customer, GETs every page, dry-runs the search forms, and **fails on any
  500 or on the error boundary rendering**. Skips honestly (exit 0, prints why)
  when `playwright` or a reachable `BASE_URL` is absent.
- `cms/scripts/record-demo.mjs` (`pnpm cms:demo:record`) — records the 60-second
  walkthrough to `cms/docs/demo/hass-cms-overview.webm` from the running app.
- `cms/docs/demo/storyboard.md` — the shot list and the run commands; doubles as
  the written designed-walkthrough fallback until the video is recorded.
- `cms/test/routes.test.ts` — runs now in `pnpm test`: guards that every page is
  in the crawl manifest and behind the `CmsError` boundary, so the crawl target
  set and the walkthrough stay complete as the app grows.

Remaining (awaits the staging Turso endpoint):

- [ ] Run `pnpm cms:crawl` green against staging.
- [ ] Record and commit `cms/docs/demo/hass-cms-overview.webm`.
