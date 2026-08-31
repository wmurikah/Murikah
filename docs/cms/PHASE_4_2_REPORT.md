# Phase 4.2 — Home dashboard clutter reduction, period filter, trend correction

Scope: the presentation of the CMS Home dashboard (`/app`) only. No workflow,
SLA or analytics business logic was changed, no schema was touched, no
deployment setting was touched.

- **Start commit:** `63e66e0`
- **Branch:** `claude/cms-approval-charts-rebuild-ij1jr9`

## A. Verbosity removed

Every explanatory paragraph under a widget is gone. What is left is microcopy
of five words or fewer, and a test now enforces that: `Home carries no
paragraph, only microcopy` counts the literal words in every `<p>` on the page
and in every `context:` string on a KPI card, and fails the build above five.

| Removed                                                                                               | Replaced by                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| "Nothing here in August 2026. 180 completions sit in other periods…"                                  | `No August data.`                                    |
| "No approval target is configured, so no target line is drawn. Set targets"                           | `No target set. Set targets`                         |
| The Group-wide affiliate paragraph under the affiliate filter                                         | nothing                                              |
| "Listed from the first completion. Ranked from 10 completions…" (leaderboard footer, three sentences) | `No approver recorded · Ranked from 10 completions.` |
| "No approver is recorded for this function in the source extract…" (leaderboard empty state)          | `No approver recorded · Show all time`               |
| The unranked divider's sentence                                                                       | `Under 10 completions`                               |
| The period-fallback sentence                                                                          | `August 2026 was empty`                              |

KPI card context lines were compressed the same way: `over 44 orders`,
`1 d 19 h slowest tenth`, `completed in May 2026`, `over 659 approvals`,
`orders waiting now`. Where a caveat still needs the long form it is a `title`
tooltip on the short form, not visible prose — the leaderboard's list of
functions with no recorded approver is the one case.

Nothing was deleted from the accessible layer: every chart still carries its
full description in `alt` and its numbers in the "Show the numbers" table, so
the shortened copy costs a screen-reader user nothing.

## B. Period filter — two dropdowns

`CmsPeriodControl` (presets, quarter, year, all time, and a typed custom range
with two `type="date"` inputs) is replaced on Home by
`src/components/cms/CmsMonthYearControl.astro`:

- **Month** — a native select, January to December.
- **Year** — a native select, only years the data actually covers.
- **Apply** — a plain GET submit. No script, no calendar, no popover.

There is no date picker and no arbitrary range on Home. The four analytics
pages keep the full period control, which is the right control for an analyst
comparing arbitrary windows; a test asserts the split so the two cannot drift.

URL state stays coherent. `parseDashboardPeriod` reads `?month=&year=` first,
falls back to `?period=…`, and normalises anything that is not a month to the
month its window ends in — so an old link to `?period=2026` lands on December
2026 with the dropdowns showing December and 2026 rather than on a control that
cannot represent what the URL asked for. The affiliate filter is carried
through the same form, so applying a month keeps it.

## C. Axes

Both charts on both panels now name both axes, drawn by one `axisTitles`
function in the chart module rather than by any page placing text in SVG:

| Chart                       | X axis    | Y axis     | Units                                          |
| --------------------------- | --------- | ---------- | ---------------------------------------------- |
| Approval by function (bars) | `MINUTES` | `FUNCTION` | ticks read `0 min`, `1 d 18 h`, `3 d 11 h`     |
| Turnaround trend (line)     | `MONTH`   | `MINUTES`  | ticks read `0 min`, `4 h 10 min`, `8 h 20 min` |

Two defects found while photographing this and fixed:

- The left gutter was a fixed 56 pixels, which fits "50 min" and clipped
  "8 h 20 min" to "h 20 min". `valueGutter` now measures the gutter from the
  three tick labels the chart is about to draw, so the unit is never sliced
  off. Covered by `a chart never clips the units off its own axis`.
- The y-axis title overprinted the first category label on the horizontal bar
  chart; the title now owns its own line (`Y_TITLE_ROOM`).

## D. Trend chart correction

The trend was bucketed by the grain of the month on screen — days — so it drew
a mark wherever an approval landed and a gap on every other day, which is the
scatter the brief describes. It is now a month-over-month line:

- The window is `trailingMonths(shown, trendSpan(shown, calendar))` — the
  months ending at the month on screen, up to twelve, sized to the data that
  exists rather than to a fixed year of mostly-empty columns.
- `approvalTrend(client, …, 'MONTH')` returns **one value per month** per
  approval function.
- Each function is one series, connected by a stroked path; markers are
  decoration on the line below fourteen points, and a run of one point always
  gets its dot so a quiet month cannot make a series vanish.
- X axis: months (`Apr`, `May`, …). Y axis: minutes, formatted as durations.

**One month of data is not a trend.** The purchase order extract covers a
single month, and a line chart over it drew one dot per function against a row
of empty months — the same scatter, arrived at from the other direction. The
chart now takes `minimumCategories: 2`: below two months with data it draws no
line and no axis, collapses to a single short line, and says **"Need more
history"**. The values it does hold are not lost — the alt text says the reason
and then reads them out, and the table underneath still carries them.

## Also fixed while here

- **Mobile horizontal overflow of 33 px.** Both panel sections are flex items
  and defaulted to `min-width: auto`, so a wide table inside them pushed the
  page. `min-w-0` on the two sections and on the KPI card (plus `break-words`
  on the figures) removes it. Measured overflow is now negative at every
  viewport.
- **Round trips unchanged, statements down.** The previous-period boards were
  redundant once the trend carries month-over-month, so they are gone: `/app`
  is still **6 round trips**, and 21 statements rather than 27.

## Validation

| Command                                                     | Result                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm run build`                                            | Complete — `astro check` 0 errors, 0 warnings; server and client built                                            |
| `pnpm lint`                                                 | 0 errors, 15 warnings — all 15 pre-existing on `main` in a file this change does not touch (verified by stashing) |
| `node --experimental-strip-types --test test/cms/*.test.ts` | 829 pass, 0 fail                                                                                                  |
| `git diff --check`                                          | clean                                                                                                             |
| `pnpm exec prettier --check src test`                       | all files match                                                                                                   |

Screenshots were taken against the real extracts (PO-Ver1.xls, 45 orders;
SO-Ver1.xls, 1,386 rows into 662 orders) at 1280, 1440 and 430 px. Horizontal
overflow measured **−15 px at every viewport** — no horizontal scroll.

## Deployment settings

**Not touched.** No change to Cloudflare dashboard settings, the build command,
the deploy command, the version command, `wrangler.jsonc`, or production branch
settings. `git status` covers eight source and test files plus one new
component; nothing under `db/`, `engr/`, `grc/`, and no CI or deployment
configuration.
