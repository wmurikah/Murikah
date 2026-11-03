# Zambia July 2026 workbook review

Two operator-supplied workbooks were inspected locally. Their contents are not
committed to this repository. This review records schema and behavior, not
customer names, user names, or cell values.

| Workbook                              | Source rows | Date column and observed range      | Affiliate source                                                       |
| ------------------------------------- | ----------: | ----------------------------------- | ---------------------------------------------------------------------- |
| `PURCHASE-ZM-01JUL2026-31JUL2026.xls` |          20 | `ORIGINAL_CREATION_DATE`, July 2–31 | `ZM` filename token → Zambia                                           |
| `SALES-ZW-01JUL2026-31JUL2026.xls`    |          49 | `CREATE_DATE_TIME`, July 1–31       | `AFFILIATE` column → Hass Petroleum Zambia; `ZW` filename alias agrees |

Both filenames claim July 1–31 and both datasets fall inside that range. The
upload preview uses the **data's** date range as its reporting period and checks
the filename separately. A mistaken filename does not change the data period.

The purchase workbook has 29 headers. All 29 map to columns in
`po_extract_rows`, including purchase number, requisition description, nature,
creation and submission dates, up to seven approval dates and approvers, the
seven approval variances, and authorization status. `import_rows.raw_json` also
keeps each parsed source row. New, unrecognized headers go to `extra_json` and
are named in the preview. The canonical `purchase_orders` row contains the
order's identity, affiliate, creation/submission dates and derived status;
approval events become workflow stages. The workbook has no line grain,
supplier, currency, order value, physical receipt or stock posting fields, so
the importer does not invent those facts or create purchase order lines.

The sales workbook has 31 headers, all mapped to `so_extract_rows`. Its 49
source rows describe 31 distinct documents: the local preview classifies 34
rows as new and 15 as repeated. Repeated source rows are retained in the
landing table. The source has 17 additional Loading Authority timestamps
beyond the one chosen for each order; the canonical order uses the earliest,
and the complete source and snapshot preserve the rest. This distinction is
important when comparing source row counts with dashboard order counts.

## Review and correction path

`/app/data/upload` validates each workbook and shows process, affiliate and
its source, date range, row/document counts, repeats, exceptions and warnings.
Validation creates an import batch and landed rows, but canonical orders are
written only when **Import valid records** is pressed. The operator can
override the affiliate before commit; sales rows still use the file's own
`AFFILIATE` column as evidence. There is no in-browser editor for source cells:
correct a bad cell in the workbook and upload the corrected file.

Duplicate bytes are refused by `import_batches.file_sha256`, regardless of
filename. A workbook resaved with different bytes but identical cell content
is also refused by its normalized content hash, which is recorded in the
append-only upload audit event and matched through a live batch. A changed
workbook is a new batch; commit updates the same canonical document and adds
its new snapshot rather than duplicating the order. Existing records and audit
history remain available for comparison.

The UI permits deletion of a batch that has **not** written canonical records.
It refuses deletion after import because other batches and order workflows may
depend on those records. Revalidate can revisit unresolved rows after mapping
changes. The separate reprocess path needs the original workbook bytes, but
file storage is not connected: `file_objects` holds metadata, not the workbook.
Operators must retain the source file and upload a corrected copy as a new
version. A deliberate test-environment reset of all order imports is a separate
maintenance operation with a database backup and explicit scope.

The `ZW` alias is resolved only if the active affiliate catalogue contains a
canonical `ZM` extract code. An exact `ZW` code, if added in the future, takes
precedence. The sales sheet's `AFFILIATE` column still wins if a filename and
sheet disagree.
