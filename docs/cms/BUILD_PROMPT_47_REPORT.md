# Build Prompt 47 — Equal panels, and nothing extra

The two panels are the same height at every desktop width, collapsed and
expanded, measured with the browser's own bounding boxes. The `More details`
dropdown is gone from both. Nothing from inside it was relocated.

## The four pairs

Measured with `getBoundingClientRect()` on `[data-cms-po-chart]` and
`[data-cms-la-chart]` in headless Chromium, against the real extracts:

| State                    | Width    | Purchase order | Loading Authority | Difference  |
| ------------------------ | -------- | -------------- | ----------------- | ----------- |
| Collapsed                | 1,280 px | **364.59 px**  | **364.59 px**     | **0.00 px** |
| Collapsed                | 1,440 px | **364.59 px**  | **364.59 px**     | **0.00 px** |
| One row expanded on each | 1,280 px | **448.77 px**  | **448.77 px**     | **0.00 px** |
| One row expanded on each | 1,440 px | **448.77 px**  | **448.77 px**     | **0.00 px** |

Two more, because they are the states that broke it before:

| State                                  | Width    | Purchase order | Loading Authority | Difference  |
| -------------------------------------- | -------- | -------------- | ----------------- | ----------- |
| August 2026, a note on one panel only  | 1,440 px | **269.77 px**  | **269.77 px**     | **0.00 px** |
| Stacked, where the rule does not apply | 430 px   | 389.98 px      | 394.11 px         | 4.13 px     |

## What was actually wrong

The cards were already equal in the state anybody had checked. Two things
made them unequal in states nobody had:

**The `More details` blocks, opened.** The purchase order disclosure measured
**1,194.94 px** open and the loading authority one **933.67 px** — a
**261.27 px** difference inside two sections the grid was still reporting as
equal. Removing the control (section 2) removes that entirely.

**A note beside one panel and not the other.** In August 2026 the purchase
order panel carries `No August data. Show June 2026`, a 17.39 px paragraph
sitting between its card and the section's end. Because the card grows into
whatever the section leaves it, that note came out of the card:

```
before   PO 232.38 px   LA 265.77 px   Δ 33.39 px
after    PO 269.77 px   LA 269.77 px   Δ  0.00 px
```

The fix is structural rather than dimensional: **each panel's notes moved
inside its card**, through a `foot` slot pinned to the bottom with the axis.
The figure is now the only child of its section whose height varies, so two
equal sections give two equal cards — in every state, rather than in the
states somebody thought to check.

## The CSS that equalises them

Three declarations, no numbers:

```html
<!-- src/pages/cms/app/index.astro -->
<div class="grid gap-6 lg:grid-cols-2">
  <section class="flex min-w-0 flex-col gap-4" aria-labelledby="panel-purchases">
    <section class="flex min-w-0 flex-col gap-4" aria-labelledby="panel-sales"></section>
  </section>
</div>
```

```html
<!-- both CmsApproverChart.astro and CmsLoadingAuthorityChart.astro -->
<figure class="flex flex-1 flex-col rounded-cms-lg bg-cms-surface p-4" …>
  …rows…
  <div class="{`${ROW}" mt-auto pt-1`}>…the axis…</div>
  <slot name="foot" />
</figure>
```

- The grid's default `align-items: stretch` makes both `<section>`s the height
  of the taller column.
- `flex-1` on each `<figure>` makes each card fill its own section.
- `mt-auto` on the axis row puts the spare space above it, so the rows sit at
  the top and the axis is pinned to the foot.

Nothing else participates. Grep over both panels and the page:

```
$ grep -nE "min-h-|h-\[|height:|min-height|transform|scale\(|offsetHeight|clientHeight|getBoundingClientRect|style\.height" \
    src/components/cms/CmsApproverChart.astro \
    src/components/cms/CmsLoadingAuthorityChart.astro \
    src/pages/cms/app/index.astro
(no output)
```

No fixed height, no `min-height`, no magic number, no transform, and no
script measuring one panel to size the other.

## Every element brought into line

| Element                                                | Before                                                         | After                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Panel notes (`No target configured`, `No August data`) | beside the card, taking **33.39 px** out of one card in August | inside the card, in the `foot` slot — **0.00 px** difference |
| `More details` block, opened                           | PO **1,194.94 px**, LA **933.67 px**                           | removed from both                                            |
| Loading Authority figcaption margin                    | `mb-2` (8 px)                                                  | `mb-3` (12 px), matching the purchase order panel            |
| Row grid, count column                                 | PO `3.5rem`, LA `4rem`                                         | both `4rem` — the wider, so `598/652` never wraps            |

**Nothing inside the Loading Authority panel is taller than its counterpart.**
Its content measures 215.76 px against the purchase order panel's 322.59 px,
so it is the panel that stretches, not the one that overflows. Two elements
are genuinely bigger and both are correct:

- the **country tabs**, 34.39 px, which the left panel has no equivalent of;
- the **axis block**, 42.78 px against 20 px, because it carries
  `target per function` on a second line — three functions sit at three
  different targets and one line collided with the maximum at panel width.

Neither costs anything: the panel has spare space above its axis either way.

## The same row height, padding and type scale

| Token            | Purchase order                                                                     | Loading Authority                  |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| Card             | `rounded-cms-lg bg-cms-surface p-4`                                                | identical                          |
| Row grid         | `grid grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)_5.5rem_4rem] items-center gap-3` | identical, character for character |
| Row height       | 37 px (36 px on the last, where the divider is dropped)                            | 37 px (36 px on the last)          |
| Primary row type | `text-cms-body-sm`                                                                 | `text-cms-body-sm`                 |
| Sub-row type     | `text-cms-caption text-cms-muted`                                                  | `text-cms-caption text-cms-muted`  |
| Primary bar      | `h-6`                                                                              | `h-6`                              |
| Sub-row bar      | `h-4`                                                                              | `h-4`                              |

## What `More details` held, and where it is now

**Nowhere. Nothing was relocated.** Two things were inside it, both named here
for a decision:

1. **The twelve-month turnaround trend**, one line per function, for both
   processes. The fragment that computes and draws it —
   `src/pages/cms/app/fragments/home-trend.astro` — is untouched and still
   answers any caller; nothing links to it from Home now. Its two
   twelve-month aggregations were the heaviest statements the page ever ran,
   which is why they were deferred behind the disclosure in the first place.
2. **The approvers leaderboard**, one per panel — person, volume, typical,
   slowest 10%, with the row detail behind each. `CmsApprovalLeaderboard` is
   untouched and rendered nowhere.

Both are a render away from coming back wherever you want them.

## How the accessible table is exposed

Unchanged by this phase, and intact on both panels: a real `<table>` with its
own `<caption>`, inside `<div id={tableId} class="sr-only">`, referenced from
the chart by `aria-describedby={tableId}` on the `<figure>`. A screen reader
reaches it from the chart, in the reading order, with every figure at both
grains. The visible toggles came off in Build Prompts 45 and 46; the tables
did not.

## Acceptance

1. **Four pairs of pixel heights, each within 2 px** — all four are exactly
   **0.00 px**. Table above. ✓
2. **Equalised by layout.** CSS pasted above; the grep for fixed heights,
   minimums, transforms and measuring scripts returns nothing. ✓
3. **The axis is pinned to the foot** (`mt-auto` on the axis row in both
   panels) **and the rows sit at the top**. ✓
4. **Elements brought into line**, each with before and after. The loading
   panel was not taller; the two places it is bigger are named with their
   heights and why they stay. ✓
5. **Same row height, padding and type scale** — token table above; the row
   grid is now one identical string in both files. ✓
6. **Narrow viewport stacks, purchase orders first**, and the equal-height
   rule does not apply there: 389.98 px against 394.11 px, each sizing to its
   own content. ✓
7. **`More details` appears nowhere on either panel.**

   ```
   $ grep -rin "more detail" src/pages/cms/app/index.astro \
       src/components/cms/CmsApproverChart.astro \
       src/components/cms/CmsLoadingAuthorityChart.astro
   (no output)
   ```

   ✓

8. **Nothing was relocated.** The trend and the leaderboard are named above
   and are on no page. ✓
9. **The accessible data table is intact and associated with each chart** —
   `sr-only`, captioned, exposed by `aria-describedby`. ✓
10. **`/app` subrequest count: 6 round trips before, 6 after** (22 statements
    both sides). Removing the disclosure removed no read, because the boards
    behind it also feed the KPI strip. ✓
11. **Lockfile diff empty, no `.sql` in the diff, no hex outside the token
    file.** ✓
12. **`pnpm build`, `pnpm lint`, `pnpm format:check` behave as on main**
    (build clean; 0 errors and 15 warnings, matching main; format clean);
    **`pnpm test` adds no new failure** — 1,541 pass, 0 fail. ✓

## Screenshots

`docs/cms/prompt47/` — `panels-1280-collapsed.png`,
`panels-1440-collapsed.png`, `panels-1280-expanded.png`,
`panels-1440-expanded.png`, `panels-1440-august-note.png` (the state that used
to differ by 33 px), and `panels-mobile.png` (stacked, purchase orders first).
