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

## Environment gates (record, do not skip silently)

- **Live CMS database**: seeding demo data, the CI smoke test (sign in and GET
  every page), and recording the real-app overview video all require the live
  `TURSO_CMS_*` binding. It is not present in this build environment, so those
  DoD items are `blocked` until the credentials are provided. Module code is
  still built and typechecked green against the committed schema snapshot.
- **Tenancy on domain tables**: the live domain tables have no `tenant_id` yet
  (the source is single-tenant). Modules scope within the Hass tenant by the
  existing columns (`country_code` for staff visibility, `customer_id` for the
  portal); each table gains `tenant_id` via a migration as a second tenant lands,
  regenerating the typed layer. This is the sensible single-tenant default and
  keeps the build green without touching the live database.

## Phases (Build Prompt 02, section 4)

1. [in progress] Customers and contacts
2. [pending] Catalog, pricing and bundles
3. [pending] Orders and approvals (incl. Oracle approvals)
4. [pending] Invoices and ETIMS
5. [pending] Payments (M-Pesa, bank, Oracle receipts)
6. [pending] Delivery locations and documents
7. [pending] Tickets, SLA and knowledge
8. [pending] Omnichannel intake and notifications
9. [pending] AI bot
10. [pending] Reports and analytics (all chart types)
11. [pending] Customer portal (full)
12. [pending] Admin and config
13. [pending] Oracle mirror and integrations wiring

## Final phase

- [blocked] 60-second whole-system overview video
  (`cms/docs/demo/hass-cms-overview.mp4`) recorded from the real running system
  with Playwright: requires the live database and seed data. The recorder
  (`cms/scripts/record-demo.ts`) and the designed-walkthrough fallback are staged
  as the modules land.
