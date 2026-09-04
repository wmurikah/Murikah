# Build Prompt 45 — One target everywhere

Loading authority comes down from 90 minutes to 30, so every approval function
in the system carries the same number. **The target itself needed no code
change**: it was read from `sla_rules`, and changing the row moved the line.
The code that did change is the rest of the addendum — the tab labels, the
zero-versus-unknown rendering, the collapsed functions and the table control —
plus one defect the new target made visible.

## Prerequisites

Both operator scripts confirmed before any code was written, with the
prompt's own queries:

```
SELECT sla_rule_id, stage_code, target_minutes, warning_minutes, active
  FROM sla_rules WHERE entity_type = 'SALES_ORDER' AND active = 1 ORDER BY stage_code;

sla_rule_id  stage_code           target_minutes  warning_minutes  active
SLAR-004     CREDIT_APPROVAL      30              25               1
SLAR-003     FINANCE_APPROVAL     30              25               1
SLAR-SO-LA   LOADING_AUTHORITY    30              25               1

SELECT affiliate_code, affiliate_name FROM affiliates ORDER BY affiliate_code;

HPC  Hass Petroleum DRC          HPU  Hass Petroleum Uganda
HPK  Hass Petroleum Kenya        HPZ  Hass Petroleum Zambia
HPR  Hass Petroleum Rwanda       HSS  Hass Petroleum South Sudan
HPT  Hass Petroleum Tanzania     HTW  Hass Terminal
```

Three rules all at 30 with a warning of 25, and exactly the eight expected
codes — including the two the script corrected, DRC from `HPD` to `HPC` and
South Sudan from `HPS` to `HSS`. Both scripts are mirrored into the test
double's seed and asserted on every run.

## Did the target need a code change? No.

The panel read each function's target from its own rule already, so changing
the row was the whole change. Run against the updated rule, with no code
touched:

```
Finance approval   target=30  n=661  median=14  over=185
Credit release     target=30  n=455  median=17  over=201
Loading authority  target=30  n=  5  median=39  over=3     (was target=90, over=2)
```

The line moved from 90 to 30 and the breach count followed it. **The 90 was
nowhere in the code**, and nothing had to be found or removed.

## The three lines are read separately

Three equal numbers hide the one defect that matters here: code reading ONE
target and drawing it three times renders exactly the panel that code reading
three does. Setting the loading rule back to 90 in a test database:

```
                     at 30                    with the loading rule at 90
Finance approval     target=30 warn=25        target=30 warn=25   (unmoved)
Credit release       target=30 warn=25        target=30 warn=25   (unmoved)
Loading authority    target=30 warn=25        target=90 warn=75   (moved)
```

Only the loading line moved, its warning moved with it, its breach count
changed with it, and finance and credit were judged identically before and
after. `test/cms/loadingAuthority.test.ts` holds this as a test — it moves the
rule, asserts `[30, 30, 90]`, asserts the other two functions' counts are
unchanged, and moves it back.

## A defect the new target uncovered

The prompt's own table says loading authority runs at 141 minutes over 662
orders with 614 past target. The panel reported **five orders**. The
difference is not the target; it is where the clock started.

Loading authority was measured from the invoice, falling back to the order —
the chain every other sales order function uses, on the reasoning that each
function should be charged for its own stretch. **The data refutes that order
of events**: on the real extract the authority is issued BEFORE the invoice on
**659 of the 664** orders that have one, minutes before and consistently
(authority 12:30:18, invoice 12:35:17). Those spans came out negative,
`MINUTES()` correctly refused to call a negative duration a fast one, and the
panel silently reported loading authority over the five orders that survived.

Measured from the order's creation — the milestone that always precedes the
authority, and the one the "Order to loading authority" card above the panel
already uses — the fixture reproduces the prompt's table almost exactly:

|                  | Prompt    | This extract, from order creation |
| ---------------- | --------- | --------------------------------- |
| Volume           | 662       | 664                               |
| Median, elapsed  | 141 min   | 140 min                           |
| Over 30, elapsed | 614 (93%) | 615 (93%)                         |

The start is now declared once, as `LOADING_AUTHORITY_START`, and both the
panel and the leaderboard read it — so the two cannot drift.

## Both breach percentages for loading authority

Over the whole extract, against the 30-minute target:

| Clock                       | Over target | Rate    |
| --------------------------- | ----------- | ------- |
| Elapsed (wall clock)        | 615 of 664  | **93%** |
| Working hours (08:00–17:00) | 613 of 664  | **92%** |

The working-day clock reports fewer, as expected, but barely: these spans are
long enough that clipping evenings and nights changes almost nothing. On the
panel's own period, May 2026 Kenya, the figure is **598 of 652 (92%)** on the
working clock the panel plots.

## Does the panel still direct attention? Observation only.

**It does, and by less than expected — because the bars are medians and the
fractions are rates, and they disagree.** Every row the panel draws in May
2026 Kenya:

| Row               | Median    | State    | Past target |
| ----------------- | --------- | -------- | ----------- |
| Finance           | 14 min    | within   | 184/659     |
| — Sulekha Abdi    | 14 min    | within   | 184/659     |
| Credit            | 17 min    | within   | 198/452     |
| — Victor Musembi  | 35 min    | **over** | 38/67       |
| — Samira Hamza    | 20 min    | within   | 83/181      |
| — Alawi Mohamed   | 13 min    | within   | 77/204      |
| Loading authority | 2 h 4 min | **over** | 598/652     |
| — Not recorded    | 2 h 4 min | **over** | 598/652     |

Three of eight rows are red, not eight of eight. The loading authority rows
are entirely red as the prompt expects, but finance and credit stay green: a
median of 14 minutes is inside the target even though 28% of the individual
orders are outside it. So the panel still directs attention — and the pairing
of a green bar with `184/659` beside it is the most informative thing on it,
because a typical approval being fast and a third of them being late are two
different facts that only appear together.

**The at-risk state distinguishes nothing on this data.** Amber marks a median
between 25 and 30 minutes, and no row lands there: the medians are 13, 14, 17,
20, 35 and 124. It is a five-minute band on a scale whose rows are decades
apart, so it will fire rarely by construction — it would take a function
sitting almost exactly on its target. It costs nothing to keep and it is the
only warning of a function about to tip over, so nothing was changed.

**The ordering is unchanged and still correct.** Approvers are slowest first
within their function (credit reads 35 > 20 > 13). The three functions
themselves are in journey order — finance, credit, loading authority — rather
than by duration, which is deliberate: the panel is a path an order takes.
That does put the worst function last today. Worth a decision if the loading
authority figure stays where it is; not changed here.

## The tab labels, and where they are read

`affiliates.affiliate_code`, selected in the country arm of the panel's own
statement (`approvalSla.ts`, the `grain = 2` arm) and rendered directly:
`HPC HPK HPR HPT HPU HPZ HSS HTW`, ordered by code because the code is what a
reader is scanning. The full name is the tab's `title` and its `aria-label`,
so hovering or a screen reader still gives `Hass Petroleum Kenya`. A test
asserts the eight codes come back from the database and that **no country
code appears as a literal anywhere in the panel** — which is what would have
caught `HPD` and `HPS` had they been compiled in.

## Which values are zero and which are unknown

| Fact                                     | Rendering                  | Why                                                                                            |
| ---------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| A function completed nothing this period | `0`, plain, **not a link** | Zero is a number. A link would open an empty list, which is worse than the number it replaced. |
| A function has no active rule            | `—`                        | The target is unknown, so no count of breaches can be claimed. The bar is grey and unjudged.   |
| Loading authority's approver             | `Not recorded`             | The person is unknown: the extract has no column naming who issued the authority.              |

**This uncovered a second defect.** A function's target was read off its own
completions, so a month in which a function ran nothing reported its target as
missing — an empty month rendered as an unconfigured one, complete with the
"No target for loading authority" offer. The targets now come from the rules
themselves, in a fourth arm of the same statement, independent of whether
anybody ran the function. Screenshots `panel-zero-completions.png` (zero) and
`panel-unknown-target.png` (unknown) show the two side by side.

## How the heights are matched

The loading authority functions are **collapsed by default**, so the panel
opens as three function rows against the purchase order panel's seven person
rows. Both figures then grow into their equal-height grid sections
(`flex flex-1 flex-col`) with their axes pinned to the foot (`mt-auto`), which
is the mechanism from Build Prompt 44 and needs no pixel value. Measured from
the rendered page:

|                         | 1,280 px | 1,440 px |
| ----------------------- | -------- | -------- |
| Purchase order panel    | 365 px   | 365 px   |
| Loading Authority panel | 365 px   | 365 px   |

At 430 px they stack, purchase orders first (top 834 px against 1,815 px).

## How the accessible table is exposed

The purchase order panel's visible "view as a table" control is gone. The
table is not: it is a real `<table>` with a `<caption>`, wrapped in a
`class="sr-only"` container and referenced by the figure through
`aria-describedby={tableId}`. A screen reader reaches it from the chart, in
the reading order, with every figure at both grains; a sighted reader sees the
chart and its drill-through links only. Nothing above it announces the same
number twice: the bars are `aria-hidden` scenery and every figure beside them
is a link with its own accessible name.

## Subrequest count

|               | Round trips | Statements |
| ------------- | ----------- | ---------- |
| `/app` before | **6**       | 22         |
| `/app` after  | **6**       | 22         |

The targets arm was added to the statement the panel already runs, so neither
figure moved.

## Acceptance

1. **Tabs read the eight affiliate codes from `affiliates.affiliate_code`,
   none hard-coded.** `HPC HPK HPR HPT HPU HPZ HSS HTW`, read in the panel
   query's country arm; a test asserts no code literal exists in the
   component. ✓
2. **The full name is the tab's title and accessible name** —
   `title={country.name}` and `aria-label={country.name}` on both the
   selectable and the greyed tabs. ✓
3. **`nothing in this period` appears nowhere.** Greyed tabs stay greyed,
   `aria-disabled` and outside the tab order.

   ```
   $ grep -rin "nothing in this period" src/
   (no output)
   ```

   ✓

4. **`No completions` appears nowhere on either panel.**

   ```
   $ grep -in "no completions" src/components/cms/CmsApproverChart.astro \
       src/components/cms/CmsLoadingAuthorityChart.astro
   (no output)
   ```

   Two hits remain elsewhere in `src/`, both in `CmsApprovalLeaderboard.astro`
   and both deliberate: that component distinguishes `No completions` (the
   period holds none) from `No approver recorded` (it holds some but names
   nobody) — the same zero-versus-unknown distinction this prompt asks for,
   in the one place it is already made correctly. ✓

5. **A count of zero renders as `0`, plain and not a link** —
   `panel-zero-completions.png`. ✓
6. **An unknown value renders as an em dash**, distinct from zero —
   `panel-unknown-target.png`. The table above says which is which. ✓
7. **The loading authority functions are collapsed by default**, three rows
   on load, opening to their approvers from a caret that mirrors itself into
   `?laRow=` — server-rendered, no fetch. ✓
8. **Both panels are 365 px at 1,280 and at 1,440**, with no fixed pixel
   height; mechanism stated above. ✓
9. **Narrow viewport stacks, purchase orders first.** ✓
10. **The visible view-as-table control is gone from the purchase order
    panel.**

    ```
    $ grep -in "view as a table\|<summary\|<details" \
        src/components/cms/CmsApproverChart.astro
    (no output)
    ```

    ✓

11. **The data-table equivalent is still present and associated with the
    chart** — `<table>` with a caption, `class="sr-only"`, exposed by
    `aria-describedby` on the figure. Asserted by test. ✓
12. **Lockfile diff empty, no `.sql` in the diff, no hex outside the token
    file.** ✓
13. **`/app` subrequest count: 6 before, 6 after.** ✓
14. **The three targets were confirmed at 30 before starting.** Query result
    pasted above. ✓
15. **No code change was needed for the target.** The line moved from 90 to
    30 from the rule row alone; `panel-collapsed.png` shows the panel
    rendering at 30. ✓
16. **Nothing was compiled in**, so there was nothing to find. ✓
17. **Setting the loading rule to 90 moves only the loading line.** Both
    states shown above and held by a test;
    `panel-loading-at-90.png` is the 90 state. ✓
18. **Loading authority is almost entirely over target on one shared axis
    scale**, no per-row normalisation: `598/652` in May 2026, its bar running
    past a target line drawn at the same place as the other two. ✓
19. **Both breach percentages**: 93% elapsed, 92% working hours (whole
    extract); 92% working hours on the panel's own period. ✓
20. **Observation on attention**: three of eight rows red rather than all
    eight; at-risk fires on nothing at these values; ordering is slowest-first
    within a function and journey order across functions. Detail above. No
    design change. ✓
21. **The count over target is still a link** and opens the breaching orders,
    slowest first — `drill-breaches.png`. ✓
22. **`pnpm build`, `pnpm lint`, `pnpm format:check` behave as on main**
    (build clean; 0 errors and 15 warnings, matching main; format clean);
    **`pnpm test` adds no new failure** — 1,541 pass, 0 fail — **and a test
    asserts each function's target is read from its own rule**
    (`the three targets are read separately, not one read three times`). ✓

## One thing left inconsistent, deliberately

The Loading Authority panel still carries its own "View as a table" control.
Section 7 asked for the purchase order panel and only that, so that is what
was changed. The same argument applies to both — say the word and it comes
off the right-hand panel too.
