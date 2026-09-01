# CMS performance and loading

Phase 5 of the CMS build: actual performance first, perceived performance
second, and never an animation to hide a wait that could simply be removed.
This document is the ledger of what was slow, what changed, and how the
loading language works. Companion documents:
[QUOTE_CATALOGUE.md](./QUOTE_CATALOGUE.md) for the sign-in quotes and
[CLOUDFLARE_PERFORMANCE_RECOMMENDATIONS.md](./CLOUDFLARE_PERFORMANCE_RECOMMENDATIONS.md)
for the advisory-only platform notes. No Cloudflare, deployment or wrangler
configuration was changed, no database schema was changed, and no security
behaviour was weakened.

## The ledger: what was actually slow

Measured and reasoned from the code and the subrequest accounting in
`test/cms/subrequests.test.ts` (one `execute()` = one Turso HTTP round trip;
one batch of any size = one round trip):

| #   | Cost, before                                                                                                                                                                                                                                                                                                                                     | Where it was paid                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1   | **3–5 database clients created per authenticated page.** The middleware made a client to resolve the session and threw it away; `CmsLayout` made another for the notification bell; the page made its own; drawers sometimes more. Every `createClient` also ran `PRAGMA foreign_keys = ON` — a full round trip before the first real statement. | Every authenticated page and API call |
| 2   | **1–2 notification round trips on the render path of every page.** The layout resolved the unread count, plus a five-row preview whenever it was non-zero, before any page byte was written.                                                                                                                                                     | Every authenticated page              |
| 3   | **The Home trend: the page's two heaviest statements for a chart behind a collapsed disclosure.** Twelve-month window aggregations over the fact tables ran on every Home view, feeding "More detail" panels most people never open.                                                                                                             | `/app`, every view                    |
| 4   | **The user detail page loaded every section's data for whichever tab was open.** Teams, roles, authority, identities, security and the audit trail all resolved to render one of them.                                                                                                                                                           | `/app/administration/users/[id]`      |
| 5   | **No visibility.** Nothing measured where a slow request spent its time, in development or production.                                                                                                                                                                                                                                           | Everywhere                            |

## What changed

### One database client per request (§26–30)

The middleware already creates a client to resolve the session; it now keeps
it. On an authenticated request it sets `locals.cmsDb`, and everything
downstream reads it through one accessor:

- `requestDb(Astro.locals)` in `src/lib/cms/db.ts` — returns the request's
  client, falling back to a fresh one (lazily importing env resolution) for
  scripts and tests that have no middleware in front of them.
- `connect(context.locals)` in `src/lib/cms/admin/crudRoute.ts` does the same
  for the API routes.

All 63 CMS pages/components and 133 API endpoints were converted. **Before: 3–5
clients (and 3–5 `PRAGMA` round trips) per page. After: one.** The pragma
still runs — once, where the client is created — so write integrity is
exactly what it was; `requestDb` never weakens it, and the client stays a
server-only value (`locals` is never serialised to the browser).

### Notifications off the critical path (§31–33)

`CmsLayout` no longer queries anything. The bell renders immediately;
`GET /api/notifications/bell` supplies the count after first paint (idle
callback), and the five-row preview is fetched only when the menu opens
(`?preview=1`). Failure is silent — a bell with no badge — with no retry
loop. The endpoint authenticates with `requireSignedIn`, reads the user id
from the session only, and rides the request-scoped client. A page that
already knows the count (the notifications page itself) passes it down and
the fetch is skipped.

### The Home trend is genuinely deferred (§37–43)

"More detail" on Home now contains geometry-matched chart skeletons; the
first expansion of either panel fetches `/app/fragments/home-trend` once, and
that one response fills both panels. This is **real deferral, not CSS
hiding**: the collapsed page runs no trend query at all. The remembered-open
preference (localStorage, from the usability phase) still works with no
second code path — restoring the disclosure fires the same `toggle` event the
click does.

Measured by the subrequest simulation: `/app` went from **6 round trips / 21
statements to 6 round trips / 19 statements**, with the two removed
statements being the widest window scans on the page; the fragment costs **1
round trip / 2 statements**, paid only by the people who open the panel.

**Server islands were evaluated and rejected** for this: `server:defer`
renders unconditionally on every page view, so an island would re-run the
trend queries for everyone — the disclosure state lives in the browser, and
only the browser can decide not to ask. The fragment fires only on genuine
expansion. **The leaderboards were deliberately not deferred**: their data
rides the approval-board query the always-visible bars already pay for, so
deferring them would remove markup but no work.

Security is unchanged: the fragment lives under `/app` behind the same
middleware, refuses without an INTERNAL principal (401), answers a bad period
with 422, clamps the month span, and the client treats a redirected response
(expired session → login) as a failure, never as content.

### The user detail page loads only the open section (§34–36)

The loader in `users/[id].astro` resolves the common data (user, assignments)
plus **one aggregate statement of scalar subselects** (`userSectionCounts`)
for the tab-strip numbers, then loads only the open tab's data: teams for
Organisation, roles/authority for Access, identities/security for Security,
the audit trail for History. Legacy deep links keep working; the History
count appears once History is opened (counting it from outside the audit
scope gate could overstate what the viewer may see).

### Instrumentation that costs nothing to keep (§5–8)

`src/lib/cms/perf.ts`: `performance.now()` spans, no dependency. Authenticated
page responses carry `Server-Timing` (e.g. `auth;dur=41, page;dur=203`) so
DevTools shows server phases beside the waterfall; any CMS request over
**750 ms** logs one structured line — `[cms.perf] path=/app total=812 auth=41
page=771` — readable in `wrangler tail` or Workers Logs. Never recorded:
cookies, tokens, passwords, SQL text or parameters, user or customer
identifiers, request bodies, query strings. A phase that runs twice reports
its sum. The numbers measure time to the response object; streamed rendering
after that point is deliberately out of scope.

### What was preserved (§44–49)

`createBatcher`/`runSection` remain the read path — the trend fragment uses
them too, which is why its two statements travel in one round trip.
Independent reads stay parallelised into single waves. Astro's existing
hover/touch prefetch stays exactly as it was — prefetch-everything was
considered and rejected (an authenticated page per link is server work, not a
static asset). **No schema or index changes were made**; index tuning
belongs in a follow-up armed with production `EXPLAIN QUERY PLAN` output and
the `[cms.perf]` figures this phase adds, not with guesses.

## The loading language

Four elements, each with one job, none with a timer that delays real work:

1. **Quote Curtain** (`CmsQuoteCurtain.astro`) — full-screen navy
   interstitial shown **only after credentials are accepted**, covering the
   one wait that cannot be removed: navigation to the workspace. The login
   script reveals it and calls `location.assign` in the same tick; the 140 ms
   pause the login page used to add before navigating is **removed**. One
   verified quote per sign-in (see QUOTE_CATALOGUE.md), previous quote
   excluded via `sessionStorage`. Failure paths — wrong password, locked
   account, server error — never show it. OIDC sign-ins never see it (that
   flow is redirect-based; inserting a curtain would add latency for
   decoration). Back/forward-cache restores hide it and re-enable the form.
2. **Navigation activity line** (`CmsNavigationProgress.astro`, mounted once
   in `CmsLayout`) — a 2.5 px indeterminate royal sweep at the top of the
   viewport when a same-origin navigation starts. It only observes clicks:
   modified clicks, non-primary buttons, `target`, `download`, external
   origins (mailto/tel included) and same-document hash jumps pass through
   untouched. A `sessionStorage` marker lets the arriving page finish the
   line (full bar, quick fade) so the gesture reads as continuous across the
   MPA. No percentages, no client router; a 20 s failsafe and a `pageshow`
   handler guarantee the loader is never a permanent state. Reduced motion
   gets a static quiet line.
3. **Skeletons** (`CmsSkeleton`, `CmsChartSkeleton`) — geometry-matched
   placeholders that appear only after 200 ms (under that, the honest loading
   state is none), hold perfectly still under reduced motion, and are
   `aria-hidden` with the owning region announcing status once. The chart
   skeleton mirrors the real chart's card, title and plot height so nothing
   moves when data arrives.
4. **Action-local busy states** (`src/lib/cms/ui/busy.ts`) — the one shared
   pattern for buttons: disabled + `aria-busy` + a worded label ("Saving…",
   never a percentage), restored in `finally`. The audit found 11 handlers
   with no double-submit protection at all; all now use the helper. The
   remaining hand-rolled handlers already disable and restore correctly and
   can adopt the helper (for the label) as they are next touched, rather than
   being churned wholesale in this phase.

## JavaScript budget

Everything above is vanilla, bundled through the existing per-component
script pattern, CSP-nonce compatible (no inline handlers, no eval): the
curtain adds **zero** script of its own (the login page owns its lifecycle),
the activity line ~1.5 KB, the bell fetch ~1 KB, the trend loader ~1.5 KB,
`busy()` ~0.3 KB. No loading library, no spinner framework, no router.

## Regression cover

`test/cms/performance.test.ts` pins: request-client reuse (behavioural),
middleware attach + Server-Timing + slow-line wiring, `connect(locals)`,
trace summing and sanitisation (behavioural), no layout notification query,
bell auth/count-only/idle-fetch, section-shaped user loading, Home running no
trend query while the fragment authorises and clamps, quote catalogue rules
and rotation (behavioural), login navigating with no timer, and the activity
line's non-interference list. `test/cms/subrequests.test.ts` enforces the
budgets, including the fragment's single round trip.
