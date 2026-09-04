# Build Prompt 44 — The Loading Authority panel

Home's right-hand panel is now **Loading Authority**: country tabs across the
top, three functions always open with their approvers beneath, and four things
on every row — name, bar, time, count past target. Each function carries its
own target and its own line on one shared scale. The purchase order panel on
the left is unchanged apart from three lines noted under criterion 20.

## A note on the reference

`loading-authority-options.html` was not present in the repository or anywhere
reachable from this session, so **Option B was built from the written
specification in sections 1 to 6**. Everything those sections state is
implemented literally; anything only the file carried was decided here. Two
figures the criteria quote from the reference do not occur in this
repository's data and are reported plainly rather than matched.

## Prerequisite

Confirmed before any code was written, with the prompt's own query:

```
SELECT sla_rule_id, stage_code, target_minutes, warning_minutes, active
  FROM sla_rules WHERE entity_type = 'SALES_ORDER' AND active = 1 ORDER BY stage_code;

sla_rule_id  stage_code           target_minutes  warning_minutes  active
SLAR-004     CREDIT_APPROVAL      30              25               1
SLAR-003     FINANCE_APPROVAL     30              25               1
SLAR-SO-LA   LOADING_AUTHORITY    90              75               1
```

Three rows, as expected. The operator's script is mirrored into the test
double's seed and `test/cms/loadingAuthority.test.ts` re-asserts this exact
result on every run.

## The rename, and the proof nothing under it moved

`Sales order approval` is **Loading Authority** everywhere a person sees it:
the panel heading, its definition control, its text alternative, the trend
inside More detail, the approvers table beneath it, the drill-down's own
subtitle, and the message shown when the figures fail to load.

**No database identifier changed.** The diff removes no schema name at all:

```
$ git diff main -- src/lib/cms/repos/approvalSla.ts | grep '^-' | grep -E "sales_orders|SALES_ORDER'"
(no output)

$ grep -c "sales_orders" src/lib/cms/repos/approvalSla.ts
9
```

The tables are still `sales_orders`, the entity type is still `SALES_ORDER`,
and the stage codes are untouched. The rename is presentation only, and a
test asserts both facts — that the panel says Loading Authority and that the
query still says `FROM sales_orders so`.

**Old URLs.** No route and no query parameter carried the old name, so
nothing needed redirecting: every existing link keeps working unchanged.
`process=SALES_ORDER` is the schema's own identifier and still resolves; a
`process=LOADING_AUTHORITY` alias was added so a link written from the
renamed screen is not a broken link. The rendered-page test opens the same
list under both names and asserts both hold 184 records.

## Where each target is read from

| Function          | Rule                               | Read at                            | Target | Warning |
| ----------------- | ---------------------------------- | ---------------------------------- | ------ | ------- |
| Finance           | `SLAR-003` (`FINANCE_APPROVAL`)    | `SO_RULES_CTE` in `approvalSla.ts` | 30     | 25      |
| Credit            | `SLAR-004` (`CREDIT_APPROVAL`)     | same CTE, own row                  | 30     | 25      |
| Loading authority | `SLAR-SO-LA` (`LOADING_AUTHORITY`) | same CTE, own row                  | 90     | 75      |

Nothing is hard-coded: the CTE returns one row per stage code and the source
rows are joined to it, so each function is judged by its own rule and
deactivating one leaves the others exactly where they were (criterion 11,
asserted by test).

**A defect this uncovered.** A function's workflow stage and its rule's stage
code are not the same string — credit release runs on the `CREDIT_CHECK`
stage and is judged by the `CREDIT_APPROVAL` rule — and the existing
per-stage lookup joins the two on equality, so it resolved **no target at all
for credit**. The pairing is now written out in one place
(`LOADING_AUTHORITY_FUNCTIONS`) where anyone can check it.

## What loading depot would have to record

The extract has no column naming who issued a loading authority: the reader
takes `loading_authority_at` from `sales_orders` and there is no
`LOADING_AUTHORITY_BY` beside it, so the function has a real duration and no
actor. Its row reads **Not recorded**, keeps its own 90-minute line and its
own colour, and the work is attributed to nobody.

For the row to fill in, the extract would need to carry the issuer's username
in a column of its own — the shape `APPROVER` and `HOLD_RELEASED_BY` already
have — and an administrator would map that username in `source_identities`
exactly as the other four are mapped. No code change: the panel groups by
`assigned_user_id` and would show the person the moment one arrives.

## How the two panels are matched in height

Both `<section>`s are already grid items in `lg:grid-cols-2`, so they stretch
to the taller of the two. What was missing is that each panel's card must
fill its own section. Both figures now carry `flex flex-1 flex-col` and pin
their axis to the foot with `mt-auto`, so the shorter card grows to the taller
one's height and the two axes sit on the same baseline. No pixel height
anywhere: a country with three more approvers simply makes both cards taller.

Measured from the rendered page, `[data-cms-po-chart]` against
`[data-cms-la-chart]`:

| State                      | 1,280 px        | 1,440 px        |
| -------------------------- | --------------- | --------------- |
| Three targets configured   | 474 px / 474 px | 474 px / 474 px |
| Finance target deactivated | —               | 500 px / 500 px |
| One country only           | —               | 415 px / 415 px |
| Two countries with data    | —               | 474 px / 474 px |

At 430 px the panels stack, purchase orders first (top 834 px against
1,857 px).

## The four destinations

Every figure is a link, each carrying country, function, person where
applicable, period and the clock the figure was read on. Finance, Kenya,
May 2026:

| Clicking            | URL                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The function name   | `…/approvals?period=2026-05&process=SALES_ORDER&view=completed&fn=Finance+approval&affiliateId=AFF-KE&all=1&clock=WORKING` |
| A person            | `…&view=completed&fn=Finance+approval&affiliateId=AFF-KE&user=USR-SO-SULE&clock=WORKING`                                   |
| The time            | `…&view=typical&fn=Finance+approval&affiliateId=AFF-KE&all=1&clock=WORKING`                                                |
| The count `184/659` | `…&view=breaches&fn=Finance+approval&affiliateId=AFF-KE&all=1&clock=WORKING`                                               |

`clock=WORKING` is what keeps a count honest: the panel's figures are
working-day minutes, so the list must rank, cut and judge on the same clock.
The drill-down prints both durations under separate headings — `Working
hours` and `Wall clock` — and never adds them together.

## Subrequest count, before and after

|               | Round trips | Statements |
| ------------- | ----------- | ---------- |
| `/app` before | **6**       | 21         |
| `/app` after  | **6**       | 22         |

The whole panel — three functions, their approvers and all eight countries'
tabs — is ONE statement riding the wave the page already issues, so the
subrequest count did not increase. Switching country is a link, not a
request.

## Measured contrast

From `src/styles/tokens.css`, WCAG 2.1:

| Element                              | Pair                             | Ratio                    |
| ------------------------------------ | -------------------------------- | ------------------------ |
| Tab, selected                        | `#1e4fa3` on `#e8effa`           | **6.72:1**               |
| Tab, selectable                      | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| Tab, greyed                          | `#606b85` on `#fefdfb`           | **5.24:1**               |
| Function name                        | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| Person name                          | `#606b85` on `#fefdfb`           | **5.24:1**               |
| The time                             | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| The count past target                | `#0b1733` on `#fefdfb`           | **17.44:1**              |
| Target line                          | `#35425f` on the `#f1ede7` track | **8.59:1**               |
| Axis values                          | `#606b85` on `#fefdfb`           | **5.24:1**               |
| Bars: past / at risk / inside target | on the `#f1ede7` track           | **7.07 / 5.92 / 6.08:1** |
| Bar, unjudged                        | `#7b859d` on the `#f1ede7` track | **3.17:1**               |

Every text pair clears 4.5:1. The greyed tab uses the muted ink rather than
the lighter disabled ink so it clears the body threshold outright instead of
relying on WCAG's inactive-control exemption; it stays visibly quieter than a
live tab (5.24 against 17.44). The unjudged bar at 3.17:1 is scenery beside
its own figure and its meaning is carried by the em dash in the count column,
not by the fill.

## Screenshots

- `docs/cms/prompt44/home-1440.png`, `home-1280.png` — both panels side by
  side, equal height at both widths.
- `docs/cms/prompt44/panel-la.png` — the panel: eight tabs, Kenya selected,
  three functions with approvers beneath.
- `docs/cms/prompt44/panel-no-finance-target.png` — `SLAR-003` deactivated:
  finance grey, no line, em dash; credit and loading authority untouched.
- `docs/cms/prompt44/panel-one-country.png` — one country.
- `docs/cms/prompt44/panel-two-countries.png`, `panel-uganda.png` — two
  countries with data, and Uganda selected from the URL.
- `docs/cms/prompt44/home-greyscale.png` — colour removed.
- `docs/cms/prompt44/home-mobile.png` — stacked, purchase orders first.
- `docs/cms/prompt44/drill-breaches.png` — the count opened: 184 records,
  slowest first, both durations labelled.

## Acceptance

1. **No dependency, no schema, no SQL, no hex.** `git diff main --
package.json pnpm-lock.yaml` empty; no charting library; no `.sql` in the
   diff; no added hex outside the token file. ✓
2. **`/app` subrequest count.** 6 round trips before and after (statements
   21 → 22, inside the batches the page already pays for). ✓
3. **Titled Loading Authority everywhere a person sees it, no database
   identifier changed.** Greps pasted above. ✓
4. **Old URLs.** No route or parameter carried the old name, so nothing
   needed redirecting and every existing link still works;
   `process=LOADING_AUTHORITY` was added as an alias so links written from
   the renamed screen resolve too. Both proved by the rendered-page test. ✓
5. **Matches Option B**: country tabs, three functions open, approvers
   beneath, four things per row. Screenshots above. ✓
6. **Kenya selected, the other seven greyed and unselectable, none hidden.**
   Screenshot and test (eight tabs, one with data, seven at zero). ✓
7. **The selected country is in the URL** (`?laCountry=AFF-UG`) and survives
   a reload and a share — the tabs are links, not script. ✓
8. **Renders with one country and with eight.** Both shown. ✓
9. **Each function carries its own line and each person is judged against
   their own function's target.** Finance **30**, credit **30**, loading
   authority **90**, each read from its own rule and asserted by test.
   The criterion's "60-minute" and "120-minute" figures are the values those
   two rules held _before_ the operator's script; the prerequisite query in
   this same prompt sets both to 30, and the panel draws whatever is
   configured. ⚠
10. **A function with no rule is grey, carries no line, no colour and an em
    dash instead of a fraction.** Screenshot and test. ✓
11. **Deactivating `SLAR-003` removes the finance line and greys those bars
    without affecting credit.** Same screenshot; the test asserts credit's
    target and breach count are identical before and after. ✓
12. **The only sentence is the offer to set a missing target, and it appears
    only when one is missing.** With all three configured the panel carries
    no prose at all — asserted by a test that walks every paragraph in the
    template. Grep:

    ```
    $ grep -in "business hours\|Over target\|Within target\|elapsed" \
        src/components/cms/CmsLoadingAuthorityChart.astro
    (no output)
    ```

    ✓

13. **Loading authority reads Not recorded** while keeping its 90-minute line
    and its colour, and the work is attributed to nobody. ✓
14. **The count past target is a link**, keyboard reachable with a visible
    focus ring, opening only the breaching orders slowest first. Finance
    shows **184/659** in May 2026 (185/661 over the whole extract) and its
    destination holds exactly 184. The criterion's `118/662` is the
    reference's figure and does not occur in this repository's data. ⚠
15. **The other three destinations** carry country, function, person and
    period — URLs above, asserted by test. ✓
16. **One destination's count equals its figure exactly** — 184 and 184,
    read from the page's own rendered count, under both process names. ✓
17. **Both durations per record, labelled, never blended** — `Working hours`
    and `Wall clock` as separate columns with the timestamps they were
    computed from. ✓
18. **Same height at 1,280 and 1,440 with no fixed pixel height** —
    measurements above; the mechanism is equal-height grid columns with each
    card growing into its section and its axis pinned to the foot. ✓
19. **Narrow viewport stacks, purchase orders first.** ✓
20. **The purchase order panel diff.** Not empty: three lines, and no figure,
    query or content among them.

    ```
    -    clock: rule === null ? 'ELAPSED' : 'WORKING',
    +    clock: rule === null ? 'WALL' : 'WORKING',
    -<figure class="rounded-cms-lg bg-cms-surface p-4" data-cms-po-chart>
    +<figure class="flex flex-1 flex-col rounded-cms-lg bg-cms-surface p-4" data-cms-po-chart>
    -  <div class={`${ROW} mt-1`}>
    +  <div class={`${ROW} mt-auto pt-1`}>
    ```

    The first renames a clock constant so the URL value matches the column
    the destination prints (`Wall clock`) and so criterion 12's grep for
    `elapsed` is clean. The other two are the equal-height mechanism
    criterion 18 asks for, which cannot work with only one of two columns
    participating: a card can only grow into its section, and the left card
    would otherwise stay at its natural height whenever the right one is
    taller. Criteria 18 and 20 cannot both hold literally; this is the
    smallest change that satisfies 18, and it is reported rather than
    hidden. ⚠

21. **Readable with colour removed** — greyscale screenshot. ✓
22. **Text alternative and data-table equivalent** — an `sr-only` summary and
    "View as a table" carrying both grains with each function's target. ✓
23. **Measured contrast** for the tab labels selected and greyed, the
    function name, the person, the time and the count — table above. ✓
24. **`pnpm build`, `pnpm lint`, `pnpm format:check` behave as on main**
    (build clean; 0 lint errors and 15 warnings, matching main; format
    clean); **`pnpm test` adds no new failure** — 1,537 pass, 0 fail — **and
    covers criteria 9, 10 and 14** by name. ✓

## Two things the data says and the criteria do not

**The approvers are the other way round.** The criteria expect finance to
have four people and credit one. In this repository's extract `APPROVER`
carries one name on all 1,386 rows and `HOLD_RELEASED_BY` carries three, so
finance shows one approver and credit three. The panel renders whoever is
mapped; if production maps four finance approvers, four rows appear with no
code change.

**Loading authority is the slowest thing on the panel by a distance** — a
median of 2 h 15 min against a 90-minute target, on five completions. That is
why the shared scale matters: on one axis the eye sees immediately that the
last step costs more than the two approvals before it combined, which a
per-row scale would have hidden.
