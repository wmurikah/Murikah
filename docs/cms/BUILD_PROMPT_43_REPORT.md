# Build Prompt 43 — The purchase order chart, by person and product

The purchase order panel's chart is no longer four bars by level. It is one bar
per approver per product group, ordered by median with the slowest at the top,
judged against the 30-minute target the operator's SLA script configured, and
each person's name expands to show their levels — server-rendered, in the URL,
with no fetch. The sales order panel is untouched.

## Prerequisite

The operator's script had run. Confirmed before any code was written, with the
prompt's own query:

```
SELECT sla_rule_id, target_minutes, warning_minutes, active
  FROM sla_rules WHERE entity_type='PURCHASE_ORDER' AND active=1;

sla_rule_id  target_minutes  warning_minutes  active
SLAR-PO-30   30              25               1
```

Exactly one row. The same script is mirrored into the test double's seed
(`test/cms/support/hassSeed.ts` — `SLAR-PO-30` active, the demo rule
`SLAR-005` deactivated to match production), and
`test/cms/approverGroupChart.test.ts` re-asserts this exact result on every
run.

## The NATURE mapping, and where it lives

**One place: `src/lib/cms/analytics/productGroups.ts`.**

```ts
export const NATURE_GROUPS: Readonly<Record<string, string>> = {
  PRODUCT: 'Fuel', // the merged view: AGO, PMS and Jet Fuel — aviation folded in
  LUBES: 'Lubricants',
  LPG: 'LPG',
};
```

The SQL arm is **built from that object** (`natureGroupSql()` compiles the
CASE), so the query cannot drift from the module, and the repository consumes
the function rather than repeating the mapping inline — asserted by test: the
literal `WHEN 'PRODUCT' THEN 'Fuel'` appears nowhere in `approvalSla.ts`.

Deliberately **not** the five-row `product_groups` table, which separates
ground fuels from aviation. The chart's grain is the three the business
answers at; the module never reads or writes that table. A NATURE value
outside the three falls to `Ungrouped` rather than being silently folded in;
on the current extract the label never renders.

NATURE itself is read from the landing table (`po_extract_rows.nature`, keyed
by purchase number), where Prompt 33 put it — never from a canonical column.

## The two clocks, side by side

The SLA rule sets `business_hours_only = 1` on a calendar of **08:00–17:00**,
so the clock the target judges counts only that window. The wall clock is what
the business experienced. Both are computed in one statement, carried as
separate fields, and printed with their names — never blended into one figure.

Omar Saad on LPG, over the whole extract (21 approvals):

| Clock                     | Median      | Over the 30-minute target |
| ------------------------- | ----------- | ------------------------- |
| Elapsed (wall clock)      | **451 min** | 16 / 21                   |
| Accountable (08:00–17:00) | **446 min** | 16 / 21                   |

The difference explained: Omar Saad's long holds run across evenings and
nights the business window does not count, so the accountable median sheds
five minutes — but at seven and a half hours against a 30-minute target, both
clocks say the same thing. The row where the clock **changes the verdict** is
Sulekha Abdi on LPG: **10 of 21** approvals breach on the wall clock, only
**8 of 21** on business hours — an approval submitted late in the day and
cleared the next morning looks long elapsed while costing little accountable
time. The engine reports **fewer** breaches on business hours than the elapsed
table, exactly as the prompt predicts, and the test pins
`accountableOverTarget <= elapsedOverTarget` on every row.

On the page: the **bar and its state judge the accountable figure** (that is
what the rule measures), labelled `business hours`; the **elapsed figure is
printed beside it**, labelled `elapsed`; the over-target counts appear for
both clocks as absolute counts — `16 / 21 business hours, 16 / 21 elapsed` —
never a percentage.

While pinning these figures the shared `MINUTES()` SQL helper was found to
round through `julianday` floats: a span of exactly 29 minutes 30 seconds came
out as 29.49999… and rounded to 29, one minute below the importer's own
arithmetic on the same timestamps. It now counts whole seconds
(`strftime('%s')`), where halves are exact — the fix is what makes the chart
agree with the section 1 table to the minute, and the full suite shows no
other figure moved on the current data.

## The thirteen rows, verified

`test/cms/approverGroupChart.test.ts` imports the real `PO-Ver1.xls` through
the real upload pipeline, maps the seven approver names through
`source_identities` (the file's reversed display-name form, exactly as an
administrator maps them), and asserts all thirteen rows in order — person,
group, volume, elapsed median, over-target count — plus the accountable
median, over-target and at-risk counts for every row:

| #   | Approver         | Group      | n   | Elapsed med | Over (elapsed) | Accountable med | Over (acc.) |
| --- | ---------------- | ---------- | --- | ----------- | -------------- | --------------- | ----------- |
| 1   | Omar Saad        | LPG        | 21  | 451         | 16 / 21        | 446             | 16 / 21     |
| 2   | Sulekha Abdi     | Fuel       | 11  | 63          | 8 / 11         | 62              | 8 / 11      |
| 3   | Gabriel Musembi  | Fuel       | 11  | 38          | 7 / 11         | 39              | 7 / 11      |
| 4   | Liban Abdimalik  | Lubricants | 13  | 37          | 7 / 13         | 26              | 6 / 13      |
| 5   | Paul Otieno      | LPG        | 5   | 36          | 5 / 5          | 36              | 5 / 5       |
| 6   | Sulekha Abdi     | LPG        | 21  | 30          | 10 / 21        | 29              | 8 / 21      |
| 7   | Gabriel Musembi  | LPG        | 16  | 26          | 8 / 16         | 27              | 8 / 16      |
| 8   | Sulekha Abdi     | Lubricants | 13  | 23          | 4 / 13         | 23              | 4 / 13      |
| 9   | Liban Abdimalik  | LPG        | 21  | 22          | 9 / 21         | 22              | 9 / 21      |
| 10  | Gabriel Musembi  | Lubricants | 13  | 18          | 5 / 13         | 18              | 5 / 13      |
| 11  | Michael Obingo   | Lubricants | 13  | 18          | 3 / 13         | 18              | 3 / 13      |
| 12  | Edmond Kiplangat | Fuel       | 11  | 9           | 0 / 11         | 8               | 0 / 11      |
| 13  | Liban Abdimalik  | Fuel       | 11  | 5           | 3 / 11         | 4               | 3 / 11      |

The elapsed columns are the section 1 table exactly, thirteen rows, Omar Saad
at the top and Liban Abdimalik on fuel at the bottom, with the 18-minute tie
broken by the over-target count (Musembi 5, Obingo 3) so the order is stable.

## Subrequest count, before and after

Measured by `test/cms/subrequests.test.ts`, which renders Home's exact read
shape against the mirrored DDL and counts round trips to Turso (the page's
subrequests) and statements:

|                           | Round trips | Statements |
| ------------------------- | ----------- | ---------- |
| `/app` before this prompt | **6**       | 19         |
| `/app` after this prompt  | **6**       | 21         |

The two new reads — the rule (`poApprovalRule`) and the board
(`approverGroupBoard`, **both grains in one statement**) — ride the same
`Promise.all` wave as the existing eleven, so the batcher coalesces them into
the batches the page already paid for: **the subrequest count did not
increase.** The drill-down costs nothing on expansion because the level rows
are in the same statement as the group rows.

## How the chart is built (no charting library)

`src/components/cms/CmsApproverGroupChart.astro` — plain markup: a CSS grid
per row (name button, bar track, figures), a percentage-width `<span>` as the
bar, and a dashed border as the target line, all from tokens. The repository
work is in `src/lib/cms/repos/approvalSla.ts`: `PO_SOURCE` gained the product
group via one landing-table join, and `APPROVER_GROUP_SQL` computes both
grains — person×group and person×group×level — in one statement, with medians
over ALL durations at each grain (never a median of medians) and both clocks'
over-target counts.

- **Target line** (`poApprovalRule`, `PO_RULE_SQL`): the 30 is `SELECT
r.target_minutes … FROM sla_rules … WHERE entity_type='PURCHASE_ORDER' AND
active=1` joined to its business calendar. No constant anywhere; the axis
  caption names it (`dashed line: 30-minute target`) and a sentence beneath
  the chart states the source rule by ID. Deactivate the rule and
  `poApprovalRule` returns null: no line is drawn, the sentence beneath the
  chart reads "No active purchase order approval target is configured, so no
  target line is drawn.", the accountable clock goes null (a window nobody
  configured cannot be counted) and the bars fall back to the labelled
  elapsed clock — pinned by test.
- **States**: over target (`bg-cms-negative` + the words `Over target`), at
  risk past the 25-minute warning (`bg-cms-caution` + `At risk`), within
  (`bg-cms-positive` + `Within target`). Colour is never the only carrier:
  every bar prints its figure and its state in words.
- **Expansion**: the level rows are server-rendered `hidden` panels; the name
  is a real `<button aria-expanded aria-controls>`; the toggle flips `hidden`
  and mirrors itself into `?poRow=` via `history.replaceState`. Shareable URL:
  `/app?month=5&year=2026&poRow=USR-OMAR~LPG`. Collapsed on load, zero fetch
  on expand, and a `hidden` flip has no motion, so `prefers-reduced-motion`
  is instant by construction.
- **Drill-through**: every figure is a link through `approvalRecordsHref`,
  which now carries the product group; the records page
  (`/app/performance/approvals?…&group=LPG`) narrows by the same landing-table
  join with the same mapping, so the destination count equals the figure by
  construction — asserted for Omar Saad's 21, for every one of his level
  figures, and for the empty case (Edmond Kiplangat on LPG holds zero).
- **Text alternative and table**: an `sr-only` paragraph states the measure,
  the target and the window; "View as a table" renders every figure with both
  clocks in labelled columns.

## Measured contrast

Computed from the token values (`src/styles/tokens.css`), WCAG 2.1 ratios:

| Element                                                    | Pair                  | Ratio                    |
| ---------------------------------------------------------- | --------------------- | ------------------------ |
| Bar labels: figures and names (`cms-ink` on `cms-surface`) | `#0b1733` / `#fefdfb` | **17.44:1**              |
| Axis and clock labels (`cms-muted` on `cms-surface`)       | `#606b85` / `#fefdfb` | **5.24:1**               |
| Target line (`cms-ink-500` on the `cms-sunken` track)      | `#606b85` / `#f1ede7` | **4.57:1**               |
| State word, over target (`cms-negative` on surface)        | `#972119` / `#fefdfb` | **8.11:1**               |
| State word, at risk (`cms-caution` on surface)             | `#824e0b` / `#fefdfb` | **6.79:1**               |
| State word, within target (`cms-positive` on surface)      | `#13653f` / `#fefdfb` | **6.98:1**               |
| Bar fills on the track (negative / caution / positive)     | on `#f1ede7`          | **7.07 / 5.92 / 6.08:1** |
| Drill links (`cms-royal` on surface)                       | `#1e4fa3` / `#fefdfb` | **7.64:1**               |

Every text pair clears the 4.5:1 AA text threshold; the target line and bar
fills clear the 3:1 non-text threshold with room.

## Screenshots

Taken from the real worker (`wrangler dev` on the build output) with the real
extract imported and the seven approvers mapped, May 2026 — the extract's own
month, which holds 174 of its 180 approvals; the six completions that landed
in June are why the on-screen May volumes sit slightly below the whole-extract
table above:

- `docs/cms/prompt43/po-chart-collapsed.png` — the panel as it loads:
  thirteen rows, slowest first, target line, both clocks, states in words,
  sales panel unchanged beside it.
- `docs/cms/prompt43/po-chart-expanded.png` — the same page at
  `/app?month=5&year=2026&poRow=USR-P43-OMAR~LPG`: Omar Saad expanded, his
  Level 1 (PO Cost Review) row beneath him with the same measure and the same
  target marking.

## Acceptance

1. **No dependency, no schema, no SQL, no hex** — `git diff main --
package.json pnpm-lock.yaml` is empty; no charting library; no `.sql` in
   the diff; no hex outside `src/styles/tokens.css`. ✓
2. **`/app` subrequest count** — 6 round trips before, 6 after (statements
   19 → 21 inside the same batches). Did not increase. ✓
3. **SLA rule confirmed first** — one row: `SLAR-PO-30, 30, 25, 1` (pasted
   above). ✓
4. **Thirteen rows matching section 1** — pinned row-by-row by
   `approverGroupChart.test.ts` against the imported extract; table above. ✓
5. **NATURE → three groups, one place, aviation folded into Fuel** —
   `src/lib/cms/analytics/productGroups.ts`; the repository provably carries
   no inline copy. ✓
6. **Target read from `sla_rules`** — `PO_RULE_SQL` in
   `src/lib/cms/repos/approvalSla.ts`; no 30 anywhere in page or component. ✓
7. **Rule deactivated → no line, one line says so** — behaviour pinned by
   test; the sentence renders beneath the chart. ✓
8. **Over-target count as `16 / 21`** — beside every bar, for both clocks,
   never a percentage. ✓
9. **Elapsed and accountable both shown, labelled, never mixed** — Omar Saad
   on LPG: 451 elapsed / 446 accountable, 16 / 21 on both clocks; difference
   explained above; separate fields end to end. ✓
10. **Over target marked by more than colour** — the figure plus the words
    `Over target` / `At risk` / `Within target` on every row. ✓
11. **Expansion server-rendered, no round trip, collapsed on load, in the
    URL** — `?poRow=USR-P43-OMAR~LPG` shown above; levels ride the page's own
    statement. ✓
12. **Instant under `prefers-reduced-motion`** — the toggle is a `hidden`
    flip; there is no transition to suppress. ✓
13. **Every figure drills; destination count equals the figure** — asserted
    exactly for the group grain (21), every level grain, and the empty
    cross-pair (0). ✓
14. **Ordered by median, slowest first** — Omar Saad top, Liban Abdimalik on
    fuel bottom, tie at 18 broken by over-target count; pinned. ✓
15. **Sales order panel unchanged** — the diff touches no sales markup, no
    sales query (`SO_SOURCE`, `chartOf`, the sales `<CmsChart>` block and its
    note are untouched); the sales panel's pinned figures across the suite
    are unchanged. ✓
16. **Text alternative and data-table equivalent** — the `sr-only` summary
    and "View as a table" with both clocks labelled. ✓
17. **Measured contrast** — table above; all pairs clear AA. ✓
18. **`pnpm build` / `pnpm lint` / `pnpm format:check` as on main; `pnpm
test` adds no new failure and covers criteria 4 and 9** — build clean,
    lint 0 errors (15 pre-existing warnings), format clean; 1,526 tests pass
    (1,520 on main + 6 new, of which criterion 4 and criterion 9 are pinned
    by name). ✓
