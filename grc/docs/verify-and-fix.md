# Verify-and-fix report (Build Prompt 35)

Date: 2026-08-06, on the integration branch
`claude/module-build-standards-3s3hw0` at `4635436` (merge of PR #101), after
the merges of PRs #98 (Outlook via Graph), #99 (MFA email OTP), #100
(auto-collapsing sidebar) and #101 (evidence everywhere). One genuine defect
was found and fixed; everything else verified clean. The full suite is green
at the end: `pnpm lint`, `pnpm build`, `pnpm format:check` and `pnpm test`
(337 tests, 0 failed, 0 skipped).

## 1. Full suite

Found wrong: `pnpm build` failed with ts(2304) in `grc/test/smoke.test.ts`:
the merge that resolved PR #101's overlap with PR #99 in the shared import
block kept Prompt 32's draft-bind assertions (which call
`isDeterministicName`) but dropped the import that feeds them.

Fixed: restored the import of `isDeterministicName` from
`src/lib/grc/storage/derived.ts` beside the Prompt 34 imports, keeping both
sides (the union rule). A per-feature-commit line-set comparison of the three
merged feature commits (`1e5e433`, `d8dc04c`, `704ffe0`) against HEAD then
confirmed this was the only dropped hunk: the sidebar and evidence branches
are fully present, and the one other flagged line (Prompt 34's
`staged.pdf` assertion) is Prompt 32's intended supersession by the
deterministic-name assertion, not a drop.

After the fix: lint clean, build clean, format clean, 337/337 tests pass
with 0 skipped.

## 2. Route and query health

Nothing wrong. The smoke suite (which is part of `pnpm test`) enumerates
every page under `src/pages/grc/**` from the filesystem router, signs in,
GETs each one (including the drill-downs `work-papers/[id]`,
`action-plans/[id]`, both edit views, and every settings screen incl.
`/settings/email`) and requires a 200 with no bounce to the sign-in screen;
every API file must appear in the mutation steps or the coverage gate fails
the run. All of it passes, so no route 500s blank, and every query runs
against the typed column layer (a phantom column fails `pnpm build`).

## 3. The Outlook email flow

Nothing wrong; every requirement verified against the code and its pinned
unit tests (`grc/test/mailGraph.test.ts`):

- Routes: `/settings/email` renders (in the smoke page sweep), gated on the
  CONFIG grant with the platform-owner escape (`settings/email.astro:23`);
  SUPER_ADMIN holds the full matrix so it passes. `GET
/api/admin/outlook/connect` and `GET /api/admin/outlook/callback` exist and
  are covered by smoke steps.
- Redirect URI: `OUTLOOK_REDIRECT_URI` in `src/lib/grc/notify/graph.ts:18`
  is exactly `https://grc.murikah.com/api/admin/outlook/callback`, used
  verbatim in both the authorize request and the code exchange; the unit
  test pins the exact string.
- Endpoints and scopes: both OAuth endpoints use the `/consumers` authority;
  `response_type=code`, scope exactly
  `offline_access Mail.Send openid email User.Read`, `prompt=consent`
  (`graph.ts:13-28`, pinned by test).
- Environment names: the delivery env reads exactly `GRAPH_CLIENT_ID`,
  `GRAPH_CLIENT_SECRET`, `GRC_MAIL_SENDER` and the optional
  `GRAPH_REFRESH_TOKEN` seed (`src/lib/grc/notify/env.ts:35-44`). A repo-wide
  grep confirms no legacy `OUTLOOK_*` name is read anywhere.
- Callback: verifies the sealed anti-forgery state (same admin, 15 minutes),
  exchanges the code, reads the address from Graph `/me`, stores the refresh
  token AES-GCM sealed in the platform config row, and only ever logs the
  token endpoint's error description, never a token; success and error land
  as clear banners on the Email screen.
- Sender: `prepareMailer` (`src/lib/grc/notify/sendMail.ts`) caches the
  access token for the isolate until expiry, writes the rotated refresh
  token back on every redemption, POSTs to
  `graph.microsoft.com/v1.0/me/sendMail`, and on an auth refusal marks the
  connection stale and logs under `[grc.mail]`. The Send test email endpoint
  is deliberately outside the production gate, so a preview can prove the
  connection.

## 4. MFA email OTP

Nothing wrong. `issueEmailOtp` (`src/lib/grc/notify/otpMail.ts`) sends
through the same `prepareMailer` Graph sender for enrolment and sign-in
alike; codes are stored as SHA-256 hashes only, expire in ten minutes, are
single-use (marked used before the session promotes), lock after five wrong
guesses and sit behind a one-minute resend cooldown, all pinned by
`grc/test/mfaEmailOtp.test.ts` and driven end to end by the smoke round
trips (switch, planted challenges, wrong/used/expired/locked, backup codes).
The enrolment lock is intact: the middleware still keys off
`record?.confirmed`, and the smoke block that locks an unenrolled auditee to
`/mfa/setup` under an ALL rule passes. Codes cannot send until Outlook is
connected, which the step surfaces (`senderror=1`) rather than hides; that
is the designed behaviour, not a defect.

## 5. Audit register and schema fixes

Nothing open. All fifteen findings from `grc/docs/system-audit.md` are
addressed at HEAD, each behind a passing check:

- 001 password reset, 002 MFA, 003 throttling: the auth flows and their
  smoke round trips (reset, TOTP and email OTP life cycles, lockout).
- 004 `listWorkPapers` viewer scoping: `repos/workPaperVisibility.ts` plus
  its unit tests.
- 005 parent enforcement and orphans: `checkActionPlanInput`, the required
  parent select, `listOrphanActionPlans`, smoke-proven.
- 006 matrix gates and 007 the enforced `PAGE_PERMISSION_MAP`:
  `auth/matrix.ts`, central `pageAccess` in `src/middleware.ts`,
  permissionMatrix tests and the smoke 403 checks.
- 008 rich text into DOCX: `richtext.ts`, `wordml.ts`, reportDocx tests.
- 011 evidence staged on create: the draft-token flow, smoke-proven.
- 012 CI round trips: the expect/verify smoke contract runs in `pnpm test`.
- 014 idle timeout: `sessionRules.ts` (60-minute sliding window) applied in
  `resolveSession`, smoke-proven. 015 legacy stubs: the four top-level stub
  routes are gone from `src/pages/grc/`.

The three schema-mismatch fixes named in the prompt are present and typed:

- Reminders honour config (was #83): `notify/reminders.ts` reads each
  organisation's `STALE_REMINDER_DAYS` and `OVERDUE_REMINDER_DAY` and runs
  the due-soon reminder (`reminderRules.test.ts`).
- AI invocation logging uses real columns (was #84 / GRC-AUD-009):
  `ai/service.ts` writes through `cols(C.ai_invocations)` and
  `cols(C.ai_providers)`.
- Legal holds use the real `entity_filter` shape (was #85 / GRC-AUD-010):
  `repos/governance.ts` selects `legal_holds.entity_filter` and evaluates it
  with the pure `holdRules` matcher, failing closed (`holdRules.test.ts`).

## 6. Shared-file overlaps

`grc/test/smoke.test.ts` is the only shared file the recent merges collided
in, and it now carries all sides: Prompt 34's MFA OTP steps and round-trip
blocks, Prompt 32's evidence steps and deterministic-name assertions, and
Prompt 31's page-sweep coverage of the new shell, with the one dropped
import restored. `src/middleware.ts` and the smoke seed were untouched by
the recent branches (the line-set comparison flagged nothing in them), and
there is no `grc/db/seed.*` file in the repository; the seeded test data
lives in `grc/test/smoke/seed.ts`, which is intact.
