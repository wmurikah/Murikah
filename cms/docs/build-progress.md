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
2. [pending] Catalog, pricing and bundles
3. [in progress] Orders and approvals (read surface built and smoke-certified
   against the seeded DB: staff list with search + status, order detail with
   lines, portal orders scoped to the signed-in customer, RBAC gate
   `orders.view`, error boundary. Write CRUD, approvals and Oracle approvals
   next.)
4. [pending] Invoices and ETIMS
5. [pending] Payments (M-Pesa, bank, Oracle receipts)
6. [pending] Delivery locations and documents
7. [pending] Tickets, SLA and knowledge
8. [pending] Omnichannel intake and notifications
9. [pending] AI bot
10. [in progress] Reports and analytics (customer analytics built and
    smoke-certified against the seeded DB: summary tiles, bar and doughnut and pie
    charts by country/type/status, top accounts. Order/invoice/payment/ticket time
    series, funnels and exports follow as those modules are seeded.)
11. [in progress] Customer portal (the portal home shows the signed-in
    customer's own account and contacts, scoped to their customer_id, and links
    to their orders (`/portal/orders`, same scope), error boundaried.
    Invoice/payment/ticket views join as those modules land.)
12. [pending] Admin and config
13. [pending] Oracle mirror and integrations wiring

## Final phase

- [blocked] 60-second whole-system overview video
  (`cms/docs/demo/hass-cms-overview.mp4`) recorded from the real running system
  with Playwright: requires the live database and seed data. The recorder
  (`cms/scripts/record-demo.ts`) and the designed-walkthrough fallback are staged
  as the modules land.
