# Build Prompt 41: the two approval panels, rebuilt — report

Branch `claude/cms-approval-charts-rebuild-ij1jr9`, delivered on PR #204 together with the
repair of the eleven build errors on `main` (reported separately on the PR). "After"
screenshots are taken against the two real extracts — `PO-Ver1.xls` (45 orders) and
`SO-Ver1.xls` (662 orders from 1,386 rows) — imported through the real upload path into the
mirrored schema, period May 2026. "Before" is `main`'s Home photographed the same way.

Screenshots, in `docs/cms/prompt41/`:

| Viewport                                 | Before                   | After                           |
| ---------------------------------------- | ------------------------ | ------------------------------- |
| 1,280 px                                 | `before-home-1280.png`   | `after-home-1280.png`           |
| 1,440 px                                 | `before-home-1440.png`   | `after-home-1440.png`           |
| 430 px                                   | `before-home-mobile.png` | `after-home-mobile.png`         |
| Empty period (August asked, data in May) | —                        | `after-home-1440-empty.png`     |
| Affiliate filter applied (Uganda)        | —                        | `after-home-1440-affiliate.png` |
| Single day (14 May, hourly grain)        | —                        | `after-home-1440-day.png`       |

## Data sources

| Element          | Source                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KPI strip        | `approvalBoard` (headline, slowest level, typical finance approval), `approvalCycle` (both end-to-end spans), `countPurchaseOrders`/`countSalesOrders` (the two queue cards) — `src/lib/cms/repos/approvalSla.ts`, `poPerformance.ts`, `soPerformance.ts` |
| Bar charts       | `approvalBoard(...).functions`: `workflow_stage_instances` joined to the configured `workflow_stages` for purchase orders; the four-arm union over stage instances and `sales_orders` milestones for sales orders                                         |
| Trend charts     | `approvalTrend`: the same source expressions, bucketed by `bucketFor` at the grain the period derives, median per (function, bucket) with the same nearest-pair arithmetic as the bars                                                                    |
| Approver tables  | `approvalBoard(...).leaders`: the same source partitioned by (function, person)                                                                                                                                                                           |
| Every drill      | `approvalRecords`: the same source expression with the grouping removed, under the same `ApprovalScope`, addressed by the one `approvalRecordsHref` builder                                                                                               |
| Affiliate filter | `affiliates` table (one statement), applied to every query through `ApprovalScope.affiliateId`                                                                                                                                                            |

## Subrequest count

Measured by `test/cms/subrequests.test.ts` with the same counting the platform uses (one
`execute` = one trip, one batch of any size = one trip):

|        | Round trips | Statements |
| ------ | ----------- | ---------- |
| Before | 6           | 14         |
| After  | **6**       | 27         |

Thirteen statements were added (two trends, two end-to-end spans, the affiliate list, and
the four boards' extra scope binds); no round trip was. The budget is 15; the brief's "13"
was a stale prose comment in the old test, not a measurement. The load shape is asserted in
the test: the calendar alone, then everything else in one coalesced wave.

## The bar sequence tokens, with measured contrast

Seven, because the purchase order template allows seven levels and the chart takes one token
per function present. All measured in `test/cms/designSweep.test.ts` (the sweep now loops
over the palette and measures each on both planes):

| Token                | Value     | On surface `#fefdfb` | On canvas `#f7f5f0` |
| -------------------- | --------- | -------------------- | ------------------- |
| `cms-series-1`       | `#1a4f9e` | 7.78:1               | 7.26:1              |
| `cms-series-2`       | `#694790` | 7.11:1               | 6.64:1              |
| `cms-series-3`       | `#7c5f1d` | 5.88:1               | 5.49:1              |
| `cms-series-4`       | `#1b6574` | 6.54:1               | 6.10:1              |
| `cms-series-5`       | `#656f86` | 4.95:1               | 4.62:1              |
| `cms-series-6` (new) | `#933a68` | 6.78:1               | 6.33:1              |
| `cms-series-7` (new) | `#4f5b23` | 7.24:1               | 6.76:1              |

Six and seven were chosen for hue distance from the five above and from the five semantic
roles: the plum sits 35° off the negative red, the moss 39° off the caution amber and 79°
off the positive green. The tightest pair on a chart is series 3 and 7 at 31°, safe because
no bar is ever identified by colour alone — every bar carries its name and its value.

## Departures from the reference images, each with its reason

1. **Bars are horizontal, so the "horizontal gridlines" run along the value axis.** The
   reference's chart is vertical with country codes for labels. These bars are approval
   functions with multi-word names in a half-width panel; seven of them vertical would force
   rotated or truncated labels, and criterion 6 requires seven to render. The gridlines do
   the same job the reference's do — they are the lines a bar's length is read against — and
   the value axis is labelled with real durations, not raw minutes.
2. **The chart is by function, not affiliate** — as the brief itself directs: purchase
   orders have no affiliate column and sales orders carry exactly one value, so the
   reference's chart would hold one bar. Affiliate is the filter above both panels.
3. **No medals; a plain numeric position**, inside the Person cell so the columns stay
   exactly four. Spoken as words to a screen reader; hidden as a numeral from it.
4. **No Fastest and no Slowest columns**; both live in the row detail, where the slowest
   opens the order that caused it. One event outside anybody's control must never rank a
   person.
5. **No Within SLA column and no target line**, because no target is configured. The wiring
   is live — `target: f.targetMinutes` reaches the chart and draws a dashed rule wherever a
   rule resolves — so configuring one brings the line back with no code change. One line
   beneath each chart says so; the link to the rules screen renders only for a reader who
   holds `SLA.RULES.MANAGE`, because navigation is permission-filtered everywhere else.
6. **Straight trend segments, not smoothed curves.** A spline between two daily medians
   draws a shape the data does not assert. The area wash, point markers (below 15 buckets)
   and end-of-line labels are kept from the reference.
7. **The headline KPI is "Approvals"/"Completions", not "total orders".** The order count
   comes from the access-scoped order repository; every other figure in the panel comes from
   the approval population, which carries no scope resolution. On the real extract those two
   disagree — an affiliate-scoped reader's purchase order count is 0 while the chart beside
   it draws 174 approvals of those same Group-wide orders — and printing both is a
   contradiction a reader can check and cannot resolve. The headline is therefore taken from
   the same population as the bars beneath it, and its destination is that population with
   the grouping removed, exact by construction. The unscoped approval aggregate is finding
   1 below.

## Acceptance criteria

**Stack**

1. ✅ `git diff origin/main -- package.json pnpm-lock.yaml` is empty (no output). No
   dependency, no charting library.
2. ✅ Hex grep over every changed file returns hits only inside
   `test/cms/designSweep.test.ts` — the hex-ban test's own scanner and its pre-existing
   contrast fixtures. No new source file carries a hex or a `[#`; the sweep's repo-wide ban
   passes.
3. ✅ No `.sql` in `git diff --name-only origin/main`; no schema change.
4. ✅ `/app`: 6 round trips before, 6 after (budget 15). Asserted in
   `test/cms/subrequests.test.ts`, which now fails the build if the page exceeds 6.
5. ✅ Both panels render from the imported extracts: four purchase order levels (PO Cost
   Review, PO Finance Approval, Country Manager Approval, Approval level 4 — the fourth
   minted from the extract by the importer) and four sales order functions. See
   `after-home-1440.png`.
6. ✅ `approvalSla.test.ts` "the chart draws the levels that exist": seven configured levels
   draw seven bars, four draw four, and no level is empty in either case.
7. ✅ Bars are by function; the affiliate filter sits above both panels, reaches every query
   through `ApprovalScope`, and `after-home-1440-affiliate.png` shows Uganda applied: the
   Kenyan sales orders drop out, the Group-wide purchase orders stay with one line saying
   why. Asserted in "the affiliate narrows sales orders and never hides a Group-wide
   purchase order".
8. ✅ The slowest tenth is a pale continuation of the same bar, closed by a tick. PO Cost
   Review: 20 min typical, 1 d 19 h (≈2,580 min) in the slowest tenth — the hundredfold gap
   the brief names, and the bar shows it as the longest run on the chart while its solid
   segment is the shortest.
9. ✅ No target line is drawn (none resolves from `sla_rules`); one line beneath each chart
   says so; the removal is in the data, never the markup.
10. ✅ Every chart: title, labelled value axis (bar charts) or labelled frame (trends), a
    text alternative (`categoryAlt`/`altOf`), and the same numbers as a table behind "Show
    the numbers".
11. ✅ Trend series are named at the end of their own lines, collision-pushed apart; no
    legend.
12. ✅ A period holding one bucket draws the point and prints its value
    (`after-home-1440-day.png`; the single-point branch in `lineChart`).

**Tables**

13. ✅ Exactly `Person · Volume · Typical · Slowest 10%` (asserted by deepEqual on
    `LEADERBOARD_HEADERS`); horizontal overflow measured at −15 px at 1,280 and 1,440 — no
    scroll.
14. ✅ Function is a `<th scope="colgroup">` heading; Gabriel Musembi acts in all four
    purchase order levels in the fixture and appears once under each, never blended —
    asserted with both rows' records proven disjoint.
15. ✅ `grep -i medal` finds only the comments recording its absence; no Fastest or Slowest
    column exists (`LEADERBOARD_HEADERS` deepEqual, plus the sweep's no-average test).
16. ✅ No Within SLA column (the sweep asserts the string is absent from the component).
17. ✅ "Ranked from 10 completions; below that, figures are shown without a comparative
    rank." is printed under both tables; an unranked person keeps every figure and no
    numeral, behind a "Fewer than 10 completions" sub-heading when ranked rows sit above.
18. ✅ Invoicing and loading authority are in both charts, absent from both tables, and the
    line beneath names them with the reason.
19. ✅ The row detail lists Fastest, Slowest and Count; the slowest links to its order and
    carries its document number.

**Drilling**

20. ✅ Every figure is an anchor with `focus-visible:ring-2 ring-focus` (ring measured
    3.38:1 on canvas); KPI cards are whole-card anchors; SVG bars and trend markers are SVG
    anchors, focusable.
21. ✅ All six destinations resolve through `approvalRecordsHref` or `drillTo`, carrying
    process, view, function, actor, affiliate and period in the URL.
22. ✅ Exactness is asserted for far more than three figures: per person — Volume, the
    tail's length AND its boundary value, pending with its oldest record; per bar
    (`EVERYONE`) — volume, tail count, and the typical view's marked median rows, for every
    function of both processes, plus under an affiliate. The list is the aggregate with the
    grouping removed, so the partition the figure was read from is the partition the list is
    cut by.

**Design**

23. ✅ Contrast measured in the sweep, not intended: KPI label and figure are
    `cms-muted` 5.24:1 / `cms-ink` 17.44:1 on surface; axis labels `cms-muted` ≥4.89:1;
    table head `cms-ink` on sunken 15.20:1; body ≥4.5:1 everywhere; the series table above.
24. ✅ No status colour is decorative: the bars, the KPI top rules and the trend lines take
    only `cms-series-*` tokens, which the sweep verifies can never be a semantic token; no
    status is carried by colour alone (the badge's label is a required prop with an icon).
25. ✅ One elevation level (the sweep's overlay-only shadow test); no page description was
    added (the sweep's description test).
26. ✅ Nothing animates beyond hover; `prefers-reduced-motion` clamps every animation to
    0.01 ms in `global.css`, asserted by the sweep.
27. ✅ An explicitly chosen empty period says "Nothing here in August 2026. 180 completions
    sit in other periods, the most recent in June 2026. Show June 2026." and the table
    offers "Show all time" with this panel's own count (`after-home-1440-empty.png`). An
    unchosen period falls back to the data as before.

**Health**

28. ✅ `pnpm build` exit 0 (main was broken by unrelated merges; fixed on this branch and
    reported on the PR). `pnpm lint`: 0 errors, 15 warnings — 14 on the old main plus one
    that arrived with main's own merges (`administration/health.astro` unused var); none
    from this phase. `pnpm format:check` passes repo-wide (it failed on main over three
    files; formatted here).
29. ✅ `pnpm test`: 1,390 tests, 4 failures — the same four GRC failures that fail on
    `main` (out of this phase's fence). New tests cover criteria 6, 14 and 22 by name.
30. ✅ `git diff --name-only origin/main` touches nothing under `engr/`, `grc/`,
    `src/lib/grc/`, `db/`, no marketing page, and none of the four fenced files; the host
    routing tests all pass.

## Findings outside this phase's scope, reported rather than repaired

1. **The approval aggregates carry no access-scope resolution.** `approvalSla.ts` reads
   every stage instance for every signed-in reader, while the order repositories resolve
   scope on every query. The panel is internally consistent (its drills use the same
   unscoped population), but an affiliate-scoped reader sees Group-wide approval figures the
   order screens correctly withhold. This is an access-control decision needing its own
   review.
2. **The purchase order importer finds no workflow definition for a Group-scope batch** when
   the only PURCHASE_ORDER definition is affiliate-scoped (as the fixture's is):
   `ordersWithoutWorkflowDefinition: 45`, and no approval stage instance is written. If
   production's definition is affiliate-scoped too, the live purchase order panel has no
   approvals to draw. A Group-wide definition (`affiliate_id IS NULL`) fixes it as data.
3. **Approver names in the extracts land in the unresolved-actors queue** until mapped, so
   both leaderboards read "none of them records who performed it" on a fresh import. The
   message now says exactly that instead of the false "Nobody completed one of these".
4. **The period control's drill panel overflows a 430 px viewport by 33 px** (pre-existing,
   `CmsPeriodControl`'s absolutely-positioned panel). The panels themselves fit; both laptop
   widths measure zero overflow.
5. **`resolveApprovalPeriod` in `approvalSla.ts`** arrived with main's #199 merge, is called
   by nothing, and duplicates `analytics/period.ts`. Left in place; recommended for
   deletion.
6. **Out-of-order timestamps in the sales extract** (a loading authority recorded before its
   invoice) used to produce negative durations — the chart printed "−19 min". They are now
   unmeasurable (NULL), exactly like a missing timestamp, which brings the four functions'
   figures in line with the extract's own statistics.
