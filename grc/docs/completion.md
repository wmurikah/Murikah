# GRC completion standard (the safety net every module merges behind)

Build Prompt 22 moved verification left: breakage is caught by the build and the
smoke test before merge, not by the user clicking a dead route in production.
From now on a module is "done" only when all of the following hold. This is the
completion standard the remaining modules (and any change to an existing one)
are held to; the wider build rules live in `grc/docs/module-build-standards.md`.

## The standard

1. **Typed columns.** Every query goes through the typed column layer
   (`src/lib/grc/schema/columns.ts`, generated from `grc/db/schema.md` by
   `grc/db/gen-columns.mjs`). A column name that does not exist on the table is
   a compile error and fails `pnpm build`.

2. **An error boundary on every route.**
   - A page wraps its frontmatter data load in `guardPageLoad(tag, load)`
     (`src/lib/grc/pageGuard.ts`) and renders `<GrcErrorCard />` when the load
     fails: the shell (sidebar, header) still renders, the failure shows as a
     branded inline card, and the cause is in the Worker logs under
     `[grc.<tag>]` with a stack. A page composed of widgets guards each widget
     separately, so one broken widget degrades in place and the rest render
     (see the dashboard).
   - API routes are covered by the middleware's last-resort boundary
     (`src/lib/grc/errorBoundary.ts`, wired in `src/middleware.ts`): an
     unhandled error becomes a logged, safe JSON error, never a stack and never
     a blank 500. Pages that somehow throw outside their own guard get the
     branded error screen from the same boundary.
   - Boundaries log and degrade. They never silently swallow an error.

3. **Covered by the smoke test, and green.** `grc/test/smoke.test.ts` boots the
   built worker against a seeded throwaway database, signs in as the seeded
   user, GETs every page and dry-runs every mutation, and fails on any 500.
   Coverage is enforced by enumeration, not by convention:
   - Pages are enumerated from `src/pages/grc/**`; a new page is covered
     automatically, and a new dynamic page fails the test until its parameter
     is mapped to a seeded row in `PAGE_PARAMS`.
   - API endpoints are enumerated from `src/pages/grc/api/**`; a new endpoint
     fails the test until a dry-run step is added to `MUTATION_STEPS`.
   - New reference or fixture rows a module needs belong in
     `grc/test/smoke/seed.ts`.

4. **Proper states on every screen.** Empty, loading and error states are all
   designed: a list with no rows shows a clean empty state (never an error, and
   never an error masquerading as empty, which is why empty states are gated
   behind the page's `loadError` flag), and failures show the branded error
   card.

## The merge gate

A module lands only when `pnpm lint`, `pnpm build`, `pnpm test` (which includes
the smoke test) and `pnpm format:check` all pass in CI. The smoke test runs on
every pull request; any 500 fails the build.
