# Build Prompt 43 — The purchase order chart, grouped by approver

The purchase order panel is now one row per approver, slowest first, with that
approver's product groups behind their caret. Each row carries four things and
nothing else: name, bar, time, count over target. Every one of those figures
opens its own records, the count included. The sales order panel is untouched.

## A note on the reference

`po-chart-options.html` was not present in the repository or anywhere else
reachable from this session, so **Option B was built from the written
specification in sections 1 to 6 rather than from the file**. Everything those
sections state is implemented literally; anything the file carried that the
prose did not — exact spacing, a particular bar height — was decided here.
Two of the numbers the acceptance criteria quote from the reference do not
occur in this repository's data; both are reported plainly under criteria 5
and 12 rather than reverse-engineered into a match.

## Prerequisite

Confirmed before any code was written, with the prompt's own query:

```
SELECT sla_rule_id, target_minutes, warning_minutes, active FROM sla_rules
 WHERE entity_type = 'PURCHASE_ORDER' AND active = 1;

sla_rule_id  target_minutes  warning_minutes  active
SLAR-PO-30   30              25               1
```

One row, as expected. The operator's script is mirrored in the test double's
seed and `test/cms/approverChart.test.ts` re-asserts this exact result on
every run.

## The NATURE mapping, and where it lives

**One place: `src/lib/cms/analytics/productGroups.ts`.**

```ts
export const NATURE_GROUPS: Readonly<Record<string, string>> = {
  PRODUCT: 'Fuel', // AGO, PMS and Jet Fuel: aviation folded in
  LUBES: 'Lubricants',
  LPG: 'LPG',
};
```

The SQL `CASE` is compiled from that object by `natureGroupSql()`, so the
query cannot drift from the module; a test asserts the literal arm appears
nowhere in `approvalSla.ts`. The five-row `product_groups` catalogue is
deliberately not used — it separates aviation from ground fuels, and the
chart's question is asked at the grain the business answers it. NATURE itself
is read from the landing rows (`po_extract_rows.nature`, keyed by purchase
number), where Build Prompt 33 put it.

## The person's aggregate, and why it is not the reference's

The reference weighted each approver's product medians by volume. **This uses
a true median over all of that approver's approvals**, computed in the same
statement by partitioning on `user_id` alone.

Both are defensible. This one was chosen because it is the same _kind_ of
number as the rows beneath it, and — the deciding argument — because it is a
number that exists in the list the figure opens. The time column links to the
`typical` view, which marks the row the median was read at, so a reader who
clicks **29 min** finds the 29-minute record marked. A volume-weighted mean of
medians lands between records and would mark none of them; the figure and its
own list would disagree by construction. The test asserts the marked row _is_
the figure.

For the record, both methods on the current data (working-day minutes, all
time):

| Approver         | n   | True median (used) | Weighted mean of product medians |
| ---------------- | --- | ------------------ | -------------------------------- |
| Omar Saad        | 21  | 446                | 446                              |
| Paul Otieno      | 5   | 36                 | 36                               |
| Gabriel Musembi  | 40  | 29.5               | 27.4                             |
| Sulekha Abdi     | 45  | 29                 | 35.3                             |
| Michael Obingo   | 13  | 18                 | 18                               |
| Liban Abdimalik  | 45  | 13                 | 18.8                             |
| Edmond Kiplangat | 11  | 8                  | 8                                |

## The narration that came off

Every string named in section 2 is gone from the panel. Case-insensitive grep
over the panel's two files:

```
$ grep -in "business hours\|over target\|within target\|dashed line" \
    src/components/cms/CmsApproverChart.astro src/pages/cms/app/index.astro
(no matches)
```

Removed: the `business hours` / `Over target` / `Within target` words beside
every figure; the `elapsed 4 h 16 min · over target 5 / 8 …` sub-line; the
axis caption; and the closing paragraph about the target. What replaced them:

- **The state is the bar's position against the dashed rule**, which survives
  greyscale and print. Colour is the second carrier, never the only one.
- **The target is marked once, on the line** — `30 min` at the head of the
  dashed rule that runs down every row.
- **The axis is bare**: `0` on the left, the maximum on the right.
- **The definition** — the measure, the 08:00–17:00 window, the rule it comes
  from and its warning level — moved into the panel's existing
  `CmsDefinition` control, on demand, printed nowhere.
- **Elapsed time is off the panel entirely.** It lives in the drill-down,
  beside the working-day figure and labelled, where a reader has asked for it.

The only sentence that can still appear beneath the chart is the one for a
target that does not exist: `No target configured. Set targets`.

## The four destinations

Every figure is a link, and each carries the person, the product where the row
is a product row, the period and the clock the figure was read on. Omar Saad,
May 2026:

| Clicking          | URL                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| The name          | `/app/performance/approvals?period=2026-05&process=PURCHASE_ORDER&view=completed&fn=&user=USR-P43-OMAR&clock=WORKING` |
| The time          | `…&view=typical&fn=&user=USR-P43-OMAR&clock=WORKING`                                                                  |
| The count `15/20` | `…&view=breaches&fn=&user=USR-P43-OMAR&clock=WORKING`                                                                 |
| A product row     | `…&view=completed&fn=&user=USR-P43-OMAR&group=LPG&clock=WORKING`                                                      |

`clock=WORKING` is new and it is what keeps the count honest: the panel's
figures are working-day minutes, so the list must rank, cut and judge on the
same clock or the count stops matching the figure. The leaderboard's figures
are wall clock and its links carry no clock, so nothing about it moved.

**A defect this found.** The records page carried a guard refusing "a named
person with no function" as a mistake. That combination is exactly what every
figure on the new panel asks, so all four destinations answered with an empty
list headed "an unrecorded actor" — and the repository was right the whole
time, which is why only a rendered-page test could catch it. The guard is
gone, and `criterion 14` in the test suite now drives the real worker, opens
the URL the count links to, and counts the rows the page rendered.

The partition was wrong for the same reason and is fixed with it: a figure
taken over every level must not be listed under a partition that still splits
by level, or the median marker and the tail index land on the wrong rows.

## Subrequest count, before and after

Measured by `test/cms/subrequests.test.ts`, which renders Home's exact read
shape and counts round trips to Turso:

|               | Round trips | Statements |
| ------------- | ----------- | ---------- |
| `/app` before | **6**       | 21         |
| `/app` after  | **6**       | 21         |

Unchanged. The panel's two reads are the same two as before — the rule, and
one statement returning both grains — riding the same `Promise.all` wave, so
expanding an approver costs nothing.

## Measured contrast

Computed from `src/styles/tokens.css`, WCAG 2.1:

| Element                            | Pair                             | Ratio                    |
| ---------------------------------- | -------------------------------- | ------------------------ |
| The approver name                  | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| The product name                   | `#606b85` on `#fefdfb`           | **5.24:1**               |
| The time                           | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| The count over target              | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| The `30 min` target mark           | `#35425f` on `#fefdfb`           | **9.86:1**               |
| The dashed target line             | `#35425f` on the `#f1ede7` track | **8.59:1**               |
| The axis values                    | `#606b85` on `#fefdfb`           | **5.24:1**               |
| Bar past target / at risk / inside | on the `#f1ede7` track           | **7.07 / 5.92 / 6.08:1** |

Every text pair clears 4.5:1; the line and the bars clear the 3:1 non-text
threshold with room.

## Screenshots

- `docs/cms/prompt43/panel-collapsed.png` — seven approvers, collapsed.
- `docs/cms/prompt43/panel-expanded.png` — Sulekha Abdi expanded to Fuel,
  LPG and Lubricants.
- `docs/cms/prompt43/panel-greyscale.png` — the same view with colour
  removed: the line still says who is over.
- `docs/cms/prompt43/panel-no-rule.png` — the rule deactivated: no line, no
  coloured bar, no count claimed.
- `docs/cms/prompt43/drill-breaches.png` — the count over target opened: 15
  records for a `15/20`, slowest first, both durations labelled.
- `docs/cms/prompt43/home-collapsed.png` — the whole page, sales panel
  beside it unchanged.

## Acceptance

1. **No dependency, no schema, no SQL, no hex.** `git diff main --
package.json pnpm-lock.yaml` is empty; no charting library; no `.sql` in
   the diff; no added hex outside the token file. ✓
2. **`/app` subrequest count.** 6 round trips before and after, 21 statements
   before and after. Did not increase. ✓
3. **The SLA rule was confirmed first.** One row: `SLAR-PO-30, 30, 25, 1`. ✓
4. **The panel matches Option B**: people collapsed, products beneath, four
   things per row. Collapsed and expanded screenshots above. ✓
5. **Seven people, ordered slowest first.** Seven on the current data, and
   the order is asserted as a property rather than a list of names.
   **Edmond Kiplangat is at the bottom**, as the criterion expects. **Omar
   Saad is at the top, not Liban Abdimalik.** Omar Saad's median is 446
   working-day minutes over 21 approvals; Liban Abdimalik's is 13 over 45.
   No aggregate over this data puts Liban above Omar — true median, mean,
   weighted mean of product medians and P90 all rank Omar first — so the
   criterion's expected top row cannot be produced from this extract without
   inventing an ordering. The full ordering, printed by the test on every
   run: `Omar Saad 446 | Paul Otieno 36 | Gabriel Musembi 29.5 | Sulekha
Abdi 29 | Michael Obingo 18 | Liban Abdimalik 13 | Edmond Kiplangat 8`. ⚠
6. **None of the four narration strings appears.** Grep pasted above, no
   matches, case-insensitive, in both panel files. ✓
7. **The axis is bare**: a left value, a right value, nothing else — asserted
   by test after stripping class names. ✓
8. **The target definition is on demand**, in the panel's `CmsDefinition`
   control, and printed nowhere. ✓
9. **Elapsed time is nowhere on the panel** and is in the drill-down, under
   its own `Wall clock` heading beside `Working hours`. ✓
10. **The target line is read from `sla_rules`.** With the rule deactivated,
    no line is drawn, no bar is coloured, no count is claimed, and Home says
    `No target configured.` — screenshot and test above. The panel then
    measures the wall clock wholesale, which its definition control states;
    what never happens is one figure on one clock beside another on the
    other. ✓
11. **Readable with colour removed** — greyscale screenshot above. ✓
12. **The count over target is a link**, keyboard reachable with a visible
    focus ring, opening only the breaches, slowest first. The rendered page
    holds exactly the figure: **15 records for Omar Saad's `15/20`** in May
    2026 (`16/21` over the whole extract), proved through the real worker.
    The criterion's `13/16` is the reference's number and does not occur in
    this repository's data for any period. ⚠
13. **The other three destinations** behave as specified, each carrying
    person, product where applicable, period and clock — URLs above. ✓
14. **One destination's count equals its figure exactly** — 15 and 15,
    asserted against the page's own rendered count. ✓
15. **Each record shows both durations, labelled, never blended** —
    `Working hours` and `Wall clock` as separate columns, with the two
    timestamps they were computed from. ✓
16. **Expansion is server-rendered, in the URL, collapsed on load, no extra
    round trip** — `?poRow=USR-P43-SULE`; the product rows ride the same
    statement as the person rows. ✓
17. **The caret is a real control**: a `<button>` with `aria-expanded`,
    `aria-controls`, an accessible name, and a visible focus ring. ✓
18. **Instant under `prefers-reduced-motion`** — the toggle flips `hidden`;
    there is no transition to suppress. ✓
19. **The NATURE mapping lives in one place**, aviation folded into Fuel —
    `src/lib/cms/analytics/productGroups.ts`. ✓
20. **The aggregate method is stated** — a true median over all the
    approver's approvals, with the reasoning and a comparison table above. ✓
21. **The sales order panel diff is empty** — no sales-order line changed in
    either the page or the repository. ✓
22. **Text alternative and data-table equivalent** — an `sr-only` summary and
    "View as a table" carrying both grains. ✓
23. **Measured contrast** for the name, the product, the time and the count —
    table above. ✓
24. **`pnpm build`, `pnpm lint`, `pnpm format:check` behave as on main**
    (build clean, 0 lint errors and 15 warnings against main's 16, format
    clean); **`pnpm test` adds no new failure** — 1,528 pass, 0 fail — **and
    covers criteria 5 and 12** by name. ✓

## One thing worth a look

With a 446-minute approver and a 30-minute target on the same linear axis,
six of the seven bars are short and hard to tell apart; the ranking and the
line still read correctly, and the time column carries the precision. The
axis is 0 to the maximum because section 2 says so. If the outlier turns out
to be permanent rather than a May artefact, a clamped axis with a marked
overflow would restore the resolution — worth a decision rather than a
silent change.
