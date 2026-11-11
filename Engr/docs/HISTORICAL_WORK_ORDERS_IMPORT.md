# Hass Group historical work order tracker - first data load

This is **historical source data**, not a reconstruction of Engineering
Rhythm approvals. The uploaded tracker provides dates, source contractor,
source Location, work description, work-order or purchase-order reference and
**expected** closure date. It does **not** establish the actual closure date,
technician acceptance, JSA, approval chain or financial amounts.

Do not convert this tracker into live `work_orders` with invented
`CREATED`, `CLOSED` or `CANCELLED` statuses. Migration **012** introduces
`legacy_work_order_history` to preserve source evidence independently.

## What the uploaded workbook contains

- **2,519** source rows, including later rows with only blank WO placeholders.
- **2,424** rows with work descriptions (the historical archive seed).
- **2,416** described rows with a Location.
- **148** distinct raw Location labels, including spelling variants and
  multiple-site/consumer-site descriptions.
- **485** historical descriptions using the nine screenshot-verified registered
  Location names that also appear in the source.
- **32** distinct *proposed* missing Hass Locations after obvious typographical
  normalisation. These are **not** automatically registered or activated.
- Eight duplicated numeric work-order references among described rows.
  The archive key is source file plus Excel row, **not** WO number.
- Raw invalid/missing dates, missing WO numbers, multiple-location entries and
  supplier/site descriptions are explicitly preserved with review flags.

The screenshot has eleven existing Locations under Hass Group, but neither
Hass Plaza (HQ) nor Nanyuki Road Godown is automatically matched to an
ambiguous historical site.

## Required sequence

1. Download the two generated artifacts from this conversation:
   `Hass_Work_Order_Import_Review.xlsx` and
   `Hass_Work_Order_Turso_Import_Package.zip`.
2. Back up **Engineering Turso**. The dataset and SQL are not stored in the
   repository to avoid committing business records.
3. Open `00_preflight_read_only.sql` and confirm exactly one
   **Hass Group** top-level tenant. Check the current Location and live WO
   counts. No child affiliate is a separate tenant.
4. Apply migration **012** with `cd Engr && pnpm db:apply` using the
   configured Engineering Turso credentials. This is preferred.
   If using the Turso Web SQL editor manually, run
   `01_create_archive_table.sql` instead. A later migration 012 run remains
   idempotent and will record the schema migration.
5. Run `02_import_history_01.sql` through
   `02_import_history_25.sql` in order, preferably with a local SQL-client
   script/CLI. Each chunk has at most 100 rows and is safe to rerun:
   `UNIQUE(org_id, source_file, source_row)` prevents duplicate imports.
6. Run `03_link_9_verified_locations.sql`. It links a history row to a
   Location ID only when the screenshot-verified name has exactly one
   database match in Hass Group. Other rows remain unlinked but visible with
   their original location text.
7. Run `05_post_import_checks.sql`. Expect **2,424** archived records,
   **485** linked rows if the nine registered names still match, and no
   foreign-key violations. The number of live `work_orders` must remain
   unchanged.
8. In **Work orders → Historical tracker**, review the imported source
   descriptions and search by reference, location or contractor. It is
   viewable only by signed-in users with organisation-scoped
   `workorder.view` permission. Contractor/technician/Location-manager
   portal roles do not receive group-wide access.
9. Review the `New Hass Candidates` and `Location Review` sheets.
   Register only confirmed Hass-operated Locations under HPK or the correct
   affiliate. Set an appropriate Region and manager through normal setup.
   The missing-Location list `04_review_new_Hass_location_candidates.sql`
   is **read-only**; it never creates sites.
10. If confirmed company-owned, optionally run
    `06_optional_prefix_verified_Hass_location.sql` to rename the existing
    *Nanyuki Road, Godown* display text to
    *Hass Nanyuki Road, Godown*. Its ID, code and relationships are not
    modified. Do not apply blanket Hass prefixes to customer/consumer sites.

## System boundaries

- Existing `stations`, `station_id`, `work_orders`,
  service requests, finance records, audit logs and maker/checker rules remain
  unchanged.
- Archive rows are not actionable work orders and never enter pending badges,
  approvals, notifications, contractor portals or active work-order states.
- The tracker contains source contractor names such as Universal, Techno,
  Synkron and Antler; these are preserved as text rather than silently creating
  prequalified contractor records.
- New live work orders should continue to follow the normal Engineering
  Rhythm request/assignment workflow and generated WO numbering.
- Do **not** retroactively alter existing station IDs or WO references to make
  a source match. Unresolved history can retain a null `station_id` until
  its identity is verified.
- No source file is stored in this PR. SQL files remain user-controlled imports.

## Validation

Before merging or deploying, in `Engr/` run:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run lint
pnpm run format:check
pnpm run db:schema:check
```

**Run schema migration 012 before deploying the archive page.** The page
requires its new table. Neither the migration nor the browser page imports the
historical rows by itself.
