# Build Prompt 42 — Read the entity from the filename

The monthly extracts arrive named by entity and period
(`SALES-KE-01AUG2026-24AUG2026.xls`), and for the purchase order extract —
which carries no affiliate column at all — the filename is the only place the
country exists. This phase teaches the importer to read it, as a claim the
operator confirms, never as evidence acted on silently.

## Prerequisite

The operator's alignment script added `affiliates.extract_code` and three
entities in production. The repository's test double
(`test/cms/support/schema.ts`, `hassSeed.ts`) was aligned to mirror it — a
nullable TypeScript-seeded column, no migration, no `.sql` — and the
confirmation query against the seeded double returns:

```
SELECT affiliate_code, affiliate_name, extract_code FROM affiliates ORDER BY extract_code;

HPD  Hass Petroleum DRC          DRC
HPK  Hass Petroleum Kenya        KE
HPR  Hass Petroleum Rwanda       RW
HPS  Hass Petroleum South Sudan  SSD
HTW  Hass Terminal               TERMINAL
HPT  Hass Petroleum Tanzania     TZ
HPU  Hass Petroleum Uganda       UG
HPZ  Hass Petroleum Zambia       ZM

rows: 8, nulls: 0
```

Eight rows, no null. (South Sudan's token is seeded as `SSD` in the test
double; the code matches whatever production's `extract_code` holds, so if
the live token differs the behaviour follows the live value with no code
change.) The same query should be run against production before first use;
`test/cms/extractResolution.test.ts` enforces the double stays at eight with
none null.

## The parsing rule, and what it rejects

`src/lib/cms/import/extractName.ts` parses `PROCESS-ENTITY-FROMDATE-TODATE`
with dates as `DDMMMYYYY`, strictly: the process must be exactly `SALES` or
`PURCHASE`, the entity token uppercase alphanumeric, both dates real calendar
dates (round-trip verified, so `31FEB2026` fails) in 2000–2100, the range not
reversed, the extension `.xls`/`.xlsx` (the extension is the one
case-forgiving part). Anything else yields **null** — no prefix sniffing, no
first-two-letters — and the upload proceeds as it did before this phase, with
the operator choosing. Rejected examples proven in tests:
`SalesReport-KE-Aug.xls`, `SALES-KE-2026AUG01-24AUG2026.xls`,
`SALES--01AUG2026-24AUG2026.xls`, plus lowercase names, impossible dates,
reversed ranges, `.csv`, and the historical `PO-Ver1.xls`.

All sixteen monthly shapes parse (2 processes × KE, UG, TZ, RW, ZM, DRC,
SSD, TERMINAL), each into process, entity token and the two ISO dates.

## The three-source resolution, and where each fired

Resolution lives in `receiveUpload` (`uploadCentre.ts`), before validation,
because validation bakes the affiliate into every row's source key
(`AFF-XX|number`) and the commit writes what the key carries.

1. **The file's own column.** The sales extract carries `AFFILIATE` on every
   row and it wins, always. The preview says "Entity taken from the file's
   own AFFILIATE column: Hass Petroleum Kenya. The filename was not needed."
   Where the name disagrees with the column — `SALES-UG-…` containing Kenya —
   the upload warns before commit: _"The file is named for Hass Petroleum
   Uganda (UG), but its AFFILIATE column names Hass Petroleum Kenya. The
   column is right and the name is the warning."_
2. **The filename token**, matched against `affiliates.extract_code` — the
   purchase order path and the point of this phase.
   `PURCHASE-UG-01AUG2026-24AUG2026.xls` resolves to Hass Petroleum Uganda,
   the preview says "Entity taken from the filename: UG, Hass Petroleum
   Uganda.", and every committed purchase order carries `AFF-UG`:

   ```
   PO 9001  affiliate_id=AFF-UG  status=APPROVED
   PO 9002  affiliate_id=AFF-UG  status=APPROVED
   ```

   An **unknown token is an exception, never a guess**: `PURCHASE-XX-…`
   returns the new `NEEDS_ENTITY` stage with **nothing written** — no batch,
   no rows — and the message _"XX matches no affiliate. The 8 that exist are
   DRC, KE, RW, SSD, TZ, UG, ZM, TERMINAL. Choose the entity this file
   belongs to; it will not be imported Group-wide by default."_ The upload
   screen offers the mapping selector on that row (with the Group-wide option
   removed for exactly this case).

3. **The operator** — the selector, kept as the fallback where nothing
   resolved (a malformed name still validates Group-wide, as before, with the
   selector available) and as the override of what did. An override re-sends
   the same file with `overrideBatchId`; the importer proves the bytes hash-
   match that batch (a different file cannot ride an override past the
   duplicate rule), rebuilds the batch in place with the chosen entity, and
   records the choice as an `IMPORT_REPROCESSED` audit event. Overriding an
   already-imported batch is refused.

## The period cross-check

The importer still derives the period from the data
(`ORIGINAL_CREATION_DATE` / `CREATE_DATE_TIME` min–max), and that derivation
is untouched — the batch's recorded reporting period stays the data's, proven
in tests. The filename's dates only check it: agreement is said quietly
("matches the filename"); disagreement warns before commit with both ranges:

```
The filename says 2026-08-01 to 2026-08-24, but the data runs 2026-04-30 to
2026-05-30. Somebody exported the wrong range or renamed a file. The data is
what is in the file, and it is what the period stays derived from.
```

## Sixteen files, one journey

The Upload Centre accepts a multi-selection. Each file becomes its own batch
with its own hash, its own entity and its own rows — a batch is a file and
that stays true — but the operator selects once, reads **one table with one
row per file** (filename, process, entity and its source, period from the
data with the cross-check, rows, documents, new, changed, repeat,
unresolved, outcome) and commits the set with one button. The filename's
process routes each file to the right importer, so one selection carries
both processes; the form's data-type select applies only to files whose name
says nothing.

Files are validated and committed **sequentially, one request per file**. A
failure in one file marks its row and the loop continues; each batch reaches
its own terminal state and the closing summary reads like "14 imported, 1
partial, 1 failed of 16 committed." The duplicate rules apply per file: a
re-sent unchanged extract is refused for that file alone, naming the batch
that holds it, and the other fifteen proceed.

**Subrequest cost.** Measured with the round-trip counter on a 45-row
purchase file: one validation request costs **22 Turso round trips** (21
before this phase; the one addition is the single `affiliates` read that
serves the token lookup, the operator's name and the known-tokens message
together). Because every file is its own Worker request, a sixteen-file
upload is sixteen requests of ~22 round trips each — no request grows with
the count, and the per-request platform limit is never approached. **At
fifty files** the picture is identical: fifty sequential requests, the same
per-request cost, roughly fifty times the wall-clock. No chunking is needed,
because the design never places two files in one server request; the
sequential client loop is itself the chunking, at chunk size one.

## What the entity unlocks (named, not built)

- **The affiliate filter on Home and the analytics pages** begins working for
  purchase orders as soon as newly imported orders carry an affiliate: the
  filter plumbing already scopes purchase queries by `affiliate_id`, so
  filtered figures stop being empty. Needs more: previously imported
  Group-wide orders stay Group-wide until re-imported; the filter list also
  now has eight entities, of which three are new.
- **The scope engine** — a country-scoped manager has been unable to see any
  purchase order at all, because every one was Group-wide. Orders imported
  with an affiliate become visible to that country's users through the
  existing scope resolution, with no engine change. Needs more: a decision
  about the historical Group-wide rows (re-import or a one-time backfill from
  the batches' own audit trail).
- **Approval resolution** — a Uganda purchase order can now find a
  Uganda-scoped approver identity, because `loadIdentities` already prefers
  the affiliate-scoped `source_identities` row over the Group row. Needs
  more: the workflow-definition scope matching (a per-affiliate
  `PURCHASE_ORDER` definition where one is wanted) and per-affiliate
  authority rules are configuration, not code, and existing orders keep the
  history they imported with.

## Acceptance

| #   | Criterion                                                      | Result                                                                                                                             |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Eight affiliates with extract codes, no null                   | Confirmed; query result above                                                                                                      |
| 2   | Sixteen shapes parse                                           | All 16 shown in `extractName.test.ts`; demo output in the PR                                                                       |
| 3   | Malformed yields nothing, operator fallback, no crash          | 9 malformed examples tested null; upload proceeds as before                                                                        |
| 4   | PURCHASE-UG → AFF-UG on the rows                               | Rows shown above; test-enforced                                                                                                    |
| 5   | SALES-KE from its own column, preview says so                  | "…file's own AFFILIATE column… filename was not needed."; test-enforced                                                            |
| 6   | Named-one-contains-another warns; column wins                  | Warning shown above; test-enforced                                                                                                 |
| 7   | Unknown token names the eight, offers to map, never Group-wide | `NEEDS_ENTITY`, nothing written; test-enforced                                                                                     |
| 8   | SALES-TERMINAL → Hass Terminal, HTW                            | Token lookup and an upload proven in tests                                                                                         |
| 9   | Preview states entity and source in plain words                | The `statement` field, rendered on the row and the detail panel                                                                    |
| 10  | Operator override before commit                                | `overrideBatchId` path, hash-proven, test-enforced                                                                                 |
| 11  | Period agreement said                                          | "matches the filename" on the row; `agrees` in the outcome                                                                         |
| 12  | Period mismatch warns with both                                | Output above; test-enforced                                                                                                        |
| 13  | Filename never overrides the data period                       | Batch period asserted to stay the data's                                                                                           |
| 14  | Sixteen files in one action, each its own batch                | Multi-select upload; one batch per file by construction                                                                            |
| 15  | One table, one row per file, entity with source                | The preview table                                                                                                                  |
| 16  | One failure does not stop the rest                             | Sequential loop marks the row and continues; summary counts                                                                        |
| 17  | Re-sent unchanged file caught per file                         | `DUPLICATE` naming the earlier batch, others unaffected                                                                            |
| 18  | Subrequest cost at 16 and at 50                                | 22 round trips per file-request; figures above                                                                                     |
| 19  | Unlocked capabilities named                                    | Section above                                                                                                                      |
| 20  | No dependency, schema or wrangler change                       | `git diff main -- package.json pnpm-lock.yaml` empty; no `.sql` in the diff                                                        |
| 21  | Build, lint, format, tests                                     | Build clean; lint 0 errors (15 pre-existing warnings, as on main); format clean; 1520/1520 tests, covering criteria 4, 6, 7 and 12 |
