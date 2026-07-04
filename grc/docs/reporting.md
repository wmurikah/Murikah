# Board and BARC reporting

The reporting module ports the source board report (`BoardReports.html`, and the
`getComprehensiveReportData` and `generateBoardReport` server functions) onto the
Engineering Rhythm stack. It aggregates existing work papers and action plans;
there is no schema change.

## How a report is built

1. **Scope (`repos/reportData.ts`).** `getComprehensiveReportData` returns, for
   the acting organisation, the observations (work papers) and action plans joined
   with affiliate and audit-area names and a derived response status. The heavy
   filters (year, date range, affiliate, audit area, work-paper status) run in SQL,
   and the role scope is enforced here: an all-observation or board role sees the
   organisation's data, a UNIT_MANAGER only their own affiliate and the items
   assigned to them. Every query is scoped by `organization_id`.
2. **Compute (`reports/reportModel.ts`).** A single pure module parses the filters
   (defaults, the last-six-months range, the UNIT_MANAGER adjustments), applies the
   risk and overdue-only filters, and builds a generic `ReportDocument` for the
   selected report type (Executive Summary, Detailed Observations, Action Plan
   Tracker, Overdue and At-Risk). All the figures live here and are unit-tested.
3. **Render.** The same `ReportDocument` is rendered two ways, so the preview and
   the download never diverge:
   - to HTML for the on-screen preview (`components/grc/ReportPreview.astro`), in
     the Murikah house style;
   - to a Word document for the export (`reports/docx/`).

## The Word export (Worker-compatible, dependency-free)

A `.docx` is an Office Open XML package: a ZIP of a small set of XML parts. The
export builds those parts and zips them with no external library, so it runs on
Cloudflare Workers with no native or Node-only dependency:

- `reports/docx/wordml.ts` turns the `ReportDocument` into the WordprocessingML
  parts (`word/document.xml`, `[Content_Types].xml`, the relationships and a
  minimal `styles.xml`), mapping the report's navy (`#1a365d`) and gold
  (`#C9A83E`) to the brand palette.
- `reports/docx/zip.ts` is a minimal stored (uncompressed) ZIP writer: local file
  headers, the central directory and the end-of-central-directory record, with
  CRC-32 per entry. A stored ZIP is a valid ZIP, which is all a `.docx` needs.
- `reports/docx/ooxml.ts` is the small glue that encodes the parts and zips them.

The XML builder and the ZIP writer are pure leaves and are unit-tested
(`grc/test/reportDocx.test.ts`): the CRC matches the standard check value, the
archive carries the five parts with a valid signature and end record, and
`document.xml` carries the report's content. The endpoint
(`pages/grc/api/reports/export.ts`) is gated on `REPORTS.view` and `REPORTS.board`,
enforces the same server-side scope, records the export in `audit_log`, and
returns the file with a sensible filename.

If a richer document is later required (images, page headers, compression), the
stored-ZIP writer can be swapped for `CompressionStream('deflate-raw')` (available
on Workers) without changing the WordprocessingML.
