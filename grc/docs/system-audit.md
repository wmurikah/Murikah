# Assurance OS system audit

Date: 2026-08-05. Auditor: Claude Code, working read-only per Build Prompt 23.

Audited state: the integration branch `claude/module-build-standards-3s3hw0` at
commit `bad5fa1` (merge of PR #82). Three pull requests were open and unmerged
at the time of the audit: #83 (notifications, Prompt 09), #84 (AI, Prompt 10)
and #85 (evidence governance, Prompt 11). Where a finding below is already
fixed in one of those open PRs, the finding says so; it remains a live defect
on the audited branch until the PR merges.

Every claim in this report carries a file path, and a line number where the
line matters. Nothing in the application was changed by this audit.

---

## 1. Executive summary

The product is substantially built. All thirty pages under `src/pages/grc/**`
render real screens backed by real queries; there are no placeholder pages left
(`grep -rl GrcPlaceholder src/pages/grc` returns nothing). The work-paper
lifecycle (draft, submit, review, approve, send to auditee, response rounds,
reopen) works end to end and is exercised by a CI smoke test that boots the
built worker against a seeded fake Turso database
(`grc/test/smoke.test.ts`, wired in `.github/workflows/ci.yml:48`).

The most serious open problems are in authentication and in consistency of
access control, not in feature coverage:

1. There is no password reset flow of any kind. The `password_reset_tokens`
   table exists in the schema and the typed column layer
   (`src/lib/grc/schema/columns.ts:455`) but nothing reads or writes it. A user
   who forgets their password is locked out until an administrator intervenes.
2. There is no multi-factor authentication for the GRC product, and no rate
   limiting or lockout on the login endpoint. For an audit platform holding
   findings about internal control failures, single-factor password login with
   unlimited guesses is a material weakness.
3. Eleven screens and endpoints gate on the literal role code `SUPER_ADMIN`
   instead of the configurable permission matrix, so the access-control screen
   cannot delegate any of them to another role.
4. The work-paper list is scoped by organisation only. Unlike action plans,
   which scope what a board member or an ordinary owner may see
   (`src/lib/grc/repos/actionPlans.ts:96`), any role granted `WORK_PAPER.read`
   sees every finding in the organisation, including drafts.
5. Work-paper-as-parent integrity has one deliberate gap: an action plan can be
   created with no parent finding (`src/pages/grc/action-plans/new.astro:81`).

Data-entry quality is serviceable but plain: every narrative field is an
unformatted `<textarea>`, and evidence can only be attached after a record is
created, never on the create form.

A full findings register is in section 8; the appendices carry the route
inventory, the linkage map and the visibility matrix.

---

## 2. Work paper as parent: integrity review

The design intent is that the work paper (the finding) is the parent record and
everything else hangs off it. The schema and the code largely honour this.

### Linkage map

| Child record        | Link to parent                                                                           | Evidence                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Action plans        | `action_plans.work_paper_id`                                                             | `grc/db/schema.md:24`; joined for display in `src/lib/grc/repos/actionPlans.ts`                                                                  |
| Auditee responses   | `auditee_responses.work_paper_id` (and optionally `action_plan_id`)                      | `grc/db/schema.md:33`; rounds tracked on the parent via `work_papers.response_round`                                                             |
| Requirements        | `work_paper_requirements.work_paper_id`                                                  | `grc/db/schema.md:75`; managed from the detail page via `src/pages/grc/api/work-papers/[id]/requirements.ts`                                     |
| Responsible persons | `work_paper_responsibles.work_paper_id`                                                  | `grc/db/schema.md:76`; drives auditee visibility in `src/lib/grc/repos/reportData.ts:108`                                                        |
| Revision history    | `work_paper_revisions.work_paper_id`                                                     | `grc/db/schema.md:77`; written on every workflow transition                                                                                      |
| CC recipients       | `work_paper_cc_recipients.work_paper_id`                                                 | `grc/db/schema.md:74`                                                                                                                            |
| Evidence files      | `file_attachments.entity_type = 'work_paper'`, `entity_id`                               | `src/lib/grc/repos/evidence.ts`; `file_attachments` itself carries no `organization_id`, scope comes from the joined `files` row                 |
| Legal holds         | `legal_holds.entity_filter` JSON naming the entity                                       | `grc/docs/schema-assumptions.md`; note the code on this branch still queries phantom `legal_holds.entity_type` columns (see finding GRC-AUD-010) |
| Notifications       | `notification_queue` / `in_app_notifications.deep_link` pointing at the work-paper route | `src/lib/grc/notify/queue.ts`                                                                                                                    |

### Integrity assessment

The parent-child chain holds for responses, requirements, responsibles,
revisions and evidence: none of those can be created without a parent, and
their pages resolve the parent inside the acting organisation before showing
anything.

There is one genuine break. The action-plan create and edit forms offer an
explicit unlinked option:

- `src/pages/grc/action-plans/new.astro:81` renders
  `<option value="">Not linked to a finding</option>`
- `src/pages/grc/action-plans/[id]/edit.astro:91` renders the same option

so `action_plans.work_paper_id` may be empty. An orphan plan never appears in
a finding's drill-down, in the observation-level report tables, or in the
response linkage. If ad hoc plans are a real business need, they should carry
an explicit flag and surface in reporting; if not, the linkage should be
required. See finding GRC-AUD-005.

A second, softer issue: because the link is set from a dropdown at create time
and derived fields (`affiliate_code`) are copied from the parent at creation
(`src/pages/grc/api/action-plans/index.ts`), a later change to the parent's
affiliate is not propagated to existing plans. This is acceptable audit-trail
behaviour but is undocumented.

---

## 3. Module build status inventory

Status legend: Built (working end to end), Partial (works with defects or with
fixes pending in an open PR), Placeholder (stub only), Erroring (throws in
normal use). There are no Placeholder or Erroring modules on the audited
branch.

| Module                                                                                      | Status            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work papers                                                                                 | Built             | List with filters and FTS (`src/lib/grc/repos/workPapers.ts:138`), create/edit form (`src/components/grc/WorkPaperForm.astro`), detail with tabs, requirements, responsibles, revisions (`src/pages/grc/work-papers/[id].astro`), data-driven workflow (`src/lib/grc/workflow/workPaperWorkflow.ts`)                                                                                                                                                                                                                                                                                          |
| Action plans                                                                                | Built             | Table and kanban with drag transitions, delegation accept/reject, overdue tracking (`src/pages/grc/action-plans.astro`, `src/lib/grc/repos/actionPlans.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Auditee responses                                                                           | Built             | Assignment-scoped queue, response rounds with deadline, reviewer accept/request-changes (`src/pages/grc/auditee-responses.astro`, `src/lib/grc/workflow/responseRounds.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Board and BARC reporting                                                                    | Built             | Six report types with the house structure, DOCX export (`src/lib/grc/reports/`, `src/pages/grc/api/reports/export.ts`), export gated on `can(locals, 'export', 'REPORT')`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Setup (affiliates, users, audit universe, dropdowns, general, access control, provisioning) | Built             | `src/pages/grc/settings/*.astro` and `src/pages/grc/api/setup/*.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Notifications                                                                               | Partial           | Bell, queue, dispatch, retry and dead-letter work (`src/lib/grc/repos/sendQueue.ts`, reconciled to the live schema in Prompt 22). Stale reminders are hard-coded to 3 days and overdue reminders to Mondays (`src/lib/grc/notify/reminders.ts:18`, `src/worker.ts:264`); the config-driven schedule and the due-soon trigger are pending in PR #83                                                                                                                                                                                                                                            |
| AI assistance                                                                               | Partial           | Config screen and save work (fixed in Prompt 22). But `src/lib/grc/ai/service.ts:77` still inserts into `ai_invocations` with a hand-written column list using `provider` where the live column is `provider_code`, and `service.ts:48` inserts into `ai_providers` with a shape (`provider_id, organization_id, provider, created_at`) that does not exist in the live table (`grc/db/schema.md`: `provider_code, display_name, api_key_secret_ref, ...`). Invocation logging therefore fails on the live database. The reconciliation, drafting help and daily limits are pending in PR #84 |
| Evidence on R2                                                                              | Partial           | Upload, presigned download, delete and content hashing work (`src/pages/grc/api/evidence/`). But `src/lib/grc/repos/governance.ts:23` queries `legal_holds.entity_type`/`entity_id`, columns the live table does not have (it has `entity_filter` JSON), so hold checks and Drive migration listing fail on the live database; and the download failure path returns an unlogged plain-text 502 (`src/pages/grc/api/evidence/[attachmentId]/download.ts:62`). Both are fixed in the pending PR #85                                                                                            |
| Change password                                                                             | Built             | Forced flow enforced in middleware (`src/middleware.ts:161`), history recorded and session rotated (`src/pages/grc/api/auth/change-password.ts:73`)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Legacy top-level stubs                                                                      | Built (redirects) | `src/pages/grc/affiliates.astro`, `users.astro`, `roles.astro`, `audit-universe.astro` are 303 redirects to their `/settings/*` replacements, kept so old bookmarks resolve                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 4. Route and drill-down health

The verification harness from Build Prompt 22 is the primary evidence here.
The smoke test (`grc/test/smoke.test.ts`) enumerates every page under
`src/pages/grc` from the filesystem, signs in as a seeded SUPER_ADMIN, and
asserts that every page returns a final 200 after redirects and is not bounced
to `/login`; dynamic routes are exercised with seeded ids (a draft finding, a
sent finding with a submitted response, an in-progress and a verifying action
plan). Mutation endpoints are driven from a coverage-checked manifest and must
not return a 500. This test runs in CI on every push
(`.github/workflows/ci.yml:44`).

Error handling is layered:

- every data-loading page wraps its queries in
  `guardPageLoad` (`src/lib/grc/pageGuard.ts`) and renders
  `GrcErrorCard` inside the intact shell on failure; 22 GRC pages carry this
  (the redirect stubs, login and change-password do not need it);
- the middleware carries a last-resort boundary
  (`src/middleware.ts:170`-`175`): anything thrown becomes a tagged log line
  and a branded error page, or JSON 500 for an API path, never a blank 500.

Route-level status: all 30 pages and 40 API endpoints (inventory in
appendix A) pass the smoke assertions on the audited branch. The known
divergences between this branch and the live database are the two schema
mismatches listed in section 3 (AI invocation logging, legal-hold columns);
the smoke test's fake database is built from `grc/db/schema.md`, which is why
both were caught and fixed in the open PRs #84 and #85.

One residual weakness in the harness itself, recorded honestly: the smoke
test's 500-detector cannot see a handler that catches its own failure and
answers 303-with-an-error-message, so a route can "pass" while silently
refusing. The deeper verification scripts used during Prompts 04 to 07
compensated by asserting database state round-trips, but those checks are not
all in CI. See finding GRC-AUD-012.

---

## 5. Access-level visibility

### The intended model

Access is a matrix, not a code list: `role_permissions(role_code, module_code,
action_code, is_allowed)` drives `can(locals, action, module)`
(`src/lib/grc/auth/rbac.ts`, pure core in `src/lib/grc/auth/matrix.ts`).
The middleware builds the matrix per request (`src/middleware.ts:129`), grants
the full matrix to SUPER_ADMIN and platform owners, and derives the legacy
permission codes (`WORK_PAPERS.view` and friends) so older call sites remain
matrix-driven (`src/lib/grc/auth/matrix.ts:103`). Roles come from the live
`roles` table (`grc/db/schema.md:63`), grants from `role_permissions`; the
access-control screen writes them
(`src/pages/grc/api/access-control.ts`).

### What actually gates each surface

Three patterns coexist:

1. **Matrix-gated (the intended pattern).** Work papers, action plans,
   auditee responses, dashboard, reports, analytics and the setup CRUD
   endpoints all gate with `can()`; 30 call sites across `src/pages/grc`
   (for example `src/pages/grc/work-papers.astro:36`,
   `src/pages/grc/api/reports/export.ts:36`,
   `src/pages/grc/api/setup/users.ts:59`).
2. **Hard-coded role checks.** Eleven surfaces test
   `grc.roleCode === 'SUPER_ADMIN'` (with the platform-owner escape) and
   consult the matrix not at all: `settings.astro:13`, `send-queue.astro:26`,
   `settings/access-control.astro:28`, `settings/dropdowns.astro:25`,
   `settings/ai.astro:25`, `settings/users.astro:23`,
   `api/send-queue/retry.ts:16`, `api/dropdowns.ts:29`,
   `api/access-control.ts:23`, `api/ai/config.ts:22`, `api/ai/test.ts:18`.
   Three more mix the two, accepting either a CONFIG grant or the literal
   role (`settings/general.astro:20`, `settings/affiliates.astro:21`,
   `settings/audit-universe.astro:27`). The consequence: the access-control
   screen cannot delegate user management, dropdowns, AI settings or the send
   queue to any other role, because those gates never read the matrix. See
   finding GRC-AUD-006.
3. **Deliberately ungated.** `notifications.astro` (user-scoped data only),
   `change-password.astro` and `login.astro`. These are correct as designed.

### PAGE_PERMISSION_MAP

`PAGE_PERMISSION_MAP` (`src/lib/grc/auth/matrix.ts:54`-`67`) maps page slugs
to a required module and action, with `pageAccess()` at `matrix.ts:70`. It is
referenced exactly once outside its own module: as a display column on the
access-control screen (`src/pages/grc/settings/access-control.astro:174`).
It is not consulted by the middleware or by any page; each page gates itself
individually. Worse, its slugs have drifted from the real routes: there is no
`work-paper-view`, `user-management`, `system-settings` or `ai-assist` route,
and real routes such as `auditee-responses`, `analytics` and `settings/ai`
have no map entry. The screen therefore shows administrators a page-access
column that does not describe the deployed routes. See finding GRC-AUD-007.

### Row-level visibility is inconsistent across modules

- Action plans scope rows by role: a board or external role sees only
  completed-side statuses, a non-auditor sees only plans they own, an auditor
  sees all (`src/lib/grc/repos/actionPlans.ts:96`-`102`).
- Report data scopes an auditee to findings they are assigned to or
  responsible for (`src/lib/grc/repos/reportData.ts:108`).
- Auditee responses scope the auditee to their assigned findings
  (`src/lib/grc/repos/auditeeResponses.ts:6`-`7`, enforced in the queue
  query and `isAssignedAuditee` at line 209).
- The work-paper list does none of this: `listWorkPapers`
  (`src/lib/grc/repos/workPapers.ts:138`-`193`) filters only on
  `wp.organization_id = ?` plus the user's chosen filters. Any role granted
  `WORK_PAPER.read` sees every finding in the organisation, at every status
  including Draft. Whether an auditee role holds that grant is a matter of
  live `role_permissions` data, which this audit cannot inspect; the code
  provides no second line of defence. See finding GRC-AUD-004.

### Module and role matrix

The matrix is data (nine modules by six actions, `matrix.ts:14`-`26`), so the
per-role truth lives in the live `role_permissions` rows, editable at
`/settings/access-control`. The structural matrix and the role codes the code
itself distinguishes are reproduced in appendix C.

---

## 6. Authentication gaps

What exists and works:

- **Sign-in**: email and password against `users.password_hash` in the
  `pbkdf2$iterations$salt$hash` format (`src/lib/grc/auth/password.ts:19`),
  signed HttpOnly SameSite=Lax session cookie
  (`src/lib/grc/auth/session.ts:63`).
- **Sessions**: database-backed with a hashed token, 12-hour expiry mirrored
  between cookie and row (`src/lib/grc/auth/session.ts:14`,
  `src/lib/grc/repos/session.ts:51`, expiry enforced at `session.ts:94`).
- **Sign-out**: `src/pages/grc/api/auth/logout.ts` deletes the session row
  and clears the cookie.
- **Forced password change**: `users.must_change_password` locks every route
  except the change screen, its endpoint and sign-out
  (`src/middleware.ts:161`-`165`); the change endpoint records the old
  credential in `password_history` and rotates the session
  (`src/pages/grc/api/auth/change-password.ts:73`-`86`).

The gaps, in severity order:

1. **No password reset.** `password_reset_tokens` appears only in the
   generated column layer (`src/lib/grc/schema/columns.ts:455`). No route,
   page or repo touches it; there is no "forgotten password" link. Recovery
   requires an administrator setting a temporary password by hand. (Build
   Prompt 21 explicitly deferred building this; it remains the largest
   auth gap.)
2. **No MFA.** `grep -ri "totp\|mfa"` over `src/lib/grc` and `src/pages/grc`
   returns nothing. The adjacent CMS product in this same repository does
   enforce a TOTP step in the shared middleware (`src/middleware.ts:208`),
   so the pattern exists in-house and the GRC product simply lacks it.
3. **No login throttling.** `src/pages/grc/api/auth/login.ts` contains no
   attempt counting, lockout or rate limiting (grep for
   `lock|attempt|throttle|rate` returns nothing). Combined with gap 2 this
   permits unbounded online password guessing.
4. **No idle timeout distinct from absolute expiry.** The session row carries
   `last_seen_at` but expiry is only checked against the fixed 12-hour
   `expires_at` (`src/lib/grc/repos/session.ts:93`-`94`); a stolen cookie is
   valid for the full window regardless of activity.

---

## 7. Data-entry quality

### Narrative fields are plain textareas

Every long-form field in the product is an unformatted `<textarea>` with no
rich-text editing, no inline lists, no bold or headings. A search for any
rich-text affordance (`contenteditable`, tiptap, quill, prosemirror) over
`src` returns nothing. The fields that matter most for report quality:

- Work-paper form (`src/components/grc/WorkPaperForm.astro`): control
  objectives (line 159), risk description (220), test objective (226),
  testing steps (232), observation description (254), risk summary (275),
  recommendation (281), management response (291).
- Action plans: description and notes on create and edit
  (`src/pages/grc/action-plans/new.astro:92`, `:128`;
  `[id]/edit.astro:102`, `:151`).
- Auditee responses: the response text and review comments
  (`src/pages/grc/auditee-responses/[id].astro:239`, `:287`).

The consequence shows downstream: the DOCX renderer
(`src/lib/grc/reports/wordml.ts`) splits recommendations on line breaks and
renders plain paragraphs, so an auditor cannot produce a numbered
recommendation list or emphasised text in the board pack without manual
post-editing. For a reporting product this is the single biggest
quality-of-output limitation. See finding GRC-AUD-008.

### Evidence attachment is a two-step flow

Evidence can be uploaded on the work-paper detail page (gated on edit rights
and configured storage in `src/pages/grc/work-papers/[id].astro`), but the
create form has no upload at all (`grep -i "upload|evidence|attach"
src/pages/grc/work-papers/new.astro` returns nothing). An auditor drafting a
finding must save it first, then reopen it to attach the supporting evidence.
The same holds for action plans and responses. Since the workflow's evidence
gate blocks sending a finding to the auditee without evidence
(`src/lib/grc/workflow/workPaperWorkflow.ts:95`), the two-step flow is a
usability tax on the critical path. See finding GRC-AUD-011.

### What is done well

Credit where due: dropdowns are data-driven from the managed `config` values
rather than hard-coded; statuses and transitions come from `enum_values`,
`status_transitions` and `workflow_terminal_states`; forms preserve entered
values on validation failure and show field-level errors; and date fields use
native date inputs with sensible defaults.

---

## 8. Findings register

Severity: High (security exposure or data-integrity break), Medium (correct
behaviour blocked or inconsistent), Low (usability or hygiene).

| ID          | Severity | Area                                 | File / route                                                                                                                                                                                                                                                                                  | Description                                                                                                                                                                                                                                                     | Recommended fix                                                                                                                                                                                        |
| ----------- | -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GRC-AUD-001 | High     | Authentication                       | `src/lib/grc/schema/columns.ts:455` (only reference)                                                                                                                                                                                                                                          | No password reset flow; `password_reset_tokens` is entirely unused. Users who forget a password are locked out.                                                                                                                                                 | Build the forgot-password flow: request endpoint issuing a single-use hashed token with a short expiry, email dispatch through the existing send queue, and a reset screen that also rotates sessions. |
| GRC-AUD-002 | High     | Authentication                       | `src/pages/grc/api/auth/login.ts`, `src/middleware.ts:67`-`176`                                                                                                                                                                                                                               | No MFA on GRC sign-in, while the sibling CMS product enforces TOTP in the same middleware (`src/middleware.ts:208`).                                                                                                                                            | Reuse the CMS TOTP pattern: a pending-MFA session state and a verification step, mandatory for SUPER_ADMIN at minimum.                                                                                 |
| GRC-AUD-003 | High     | Authentication                       | `src/pages/grc/api/auth/login.ts`                                                                                                                                                                                                                                                             | No rate limiting, attempt counting or lockout on login; unbounded online guessing.                                                                                                                                                                              | Add per-user and per-IP attempt counters with progressive delay or temporary lockout; log failures to `audit_activity`.                                                                                |
| GRC-AUD-004 | High     | Access control                       | `src/lib/grc/repos/workPapers.ts:138`-`193`                                                                                                                                                                                                                                                   | `listWorkPapers` scopes by organisation only; any role with `WORK_PAPER.read` sees all findings at all statuses, unlike the scoped action-plan and report queries.                                                                                              | Add a `Viewer` parameter mirroring `actionPlans.ts:96`: auditee-side roles restricted to findings they are assigned to or responsible for; consider hiding Draft from non-authors.                     |
| GRC-AUD-005 | Medium   | Data integrity                       | `src/pages/grc/action-plans/new.astro:81`, `[id]/edit.astro:91`                                                                                                                                                                                                                               | Action plans can be created with no parent work paper, so orphan plans exist outside every finding drill-down and observation-level report.                                                                                                                     | Either require the linkage, or make "ad hoc" an explicit flagged type that reporting surfaces deliberately.                                                                                            |
| GRC-AUD-006 | Medium   | Access control                       | `settings.astro:13`, `send-queue.astro:26`, `settings/access-control.astro:28`, `settings/dropdowns.astro:25`, `settings/ai.astro:25`, `settings/users.astro:23`, `api/send-queue/retry.ts:16`, `api/dropdowns.ts:29`, `api/access-control.ts:23`, `api/ai/config.ts:22`, `api/ai/test.ts:18` | Eleven surfaces gate on the literal `SUPER_ADMIN` role code, bypassing the configurable matrix; these functions cannot be delegated via the access-control screen.                                                                                              | Gate on `can()` with the appropriate CONFIG or USER grants (as the general, affiliates and audit-universe screens already do), keeping the platform-owner escape.                                      |
| GRC-AUD-007 | Medium   | Access control                       | `src/lib/grc/auth/matrix.ts:54`-`67`, `settings/access-control.astro:174`                                                                                                                                                                                                                     | `PAGE_PERMISSION_MAP` is display-only and its slugs have drifted from the real routes (no `work-paper-view`, `user-management` routes; no entries for `auditee-responses`, `analytics`). Administrators see a page-access column that misdescribes the product. | Regenerate the map from the actual route inventory and either enforce it centrally in the middleware or remove it from the admin screen.                                                               |
| GRC-AUD-008 | Medium   | Data entry                           | `src/components/grc/WorkPaperForm.astro:254`, `:281` and all narrative fields                                                                                                                                                                                                                 | All narrative content is plain textareas; no formatting survives into the DOCX board pack.                                                                                                                                                                      | Adopt a minimal rich-text editor (lists, bold, headings) with sanitised storage, and extend `wordml.ts` to render the marks.                                                                           |
| GRC-AUD-009 | Medium   | AI (pending PR #84)                  | `src/lib/grc/ai/service.ts:48`, `:77`                                                                                                                                                                                                                                                         | Invocation logging inserts hand-written columns (`provider`, `provider_id`, `organization_id` on `ai_providers`) that do not exist in the live schema, so AI usage tracking fails at runtime on the audited branch.                                             | Merge PR #84, which rewrites both inserts through the typed column layer against the live shapes.                                                                                                      |
| GRC-AUD-010 | Medium   | Evidence governance (pending PR #85) | `src/lib/grc/repos/governance.ts:23`, `:122`                                                                                                                                                                                                                                                  | Legal-hold checks query phantom `legal_holds.entity_type`/`entity_id` columns; the live table stores an `entity_filter` JSON. Hold enforcement and Drive-migration listing fail on the live database.                                                           | Merge PR #85, which matches holds through the `entity_filter` JSON fail-closed.                                                                                                                        |
| GRC-AUD-011 | Low      | Data entry                           | `src/pages/grc/work-papers/new.astro` (no upload code)                                                                                                                                                                                                                                        | Evidence cannot be attached during creation; the evidence gate on sending (`workPaperWorkflow.ts:95`) makes this two-step flow a tax on the critical path.                                                                                                      | Allow staging uploads on the create form, binding them to the new record on save.                                                                                                                      |
| GRC-AUD-012 | Low      | Verification                         | `grc/test/smoke.test.ts`                                                                                                                                                                                                                                                                      | The CI smoke assertions catch 500s but not handlers that answer 303-with-an-error; a route can pass while silently refusing. Deeper state round-trip checks exist but are not all in CI.                                                                        | Promote the per-module state round-trip scripts into the CI test, asserting database effects after each mutation.                                                                                      |
| GRC-AUD-013 | Low      | Notifications (pending PR #83)       | `src/lib/grc/notify/reminders.ts:18`, `src/worker.ts:264`                                                                                                                                                                                                                                     | Stale reminders are hard-coded to 3 days and overdue reminders to Mondays, ignoring the per-organisation config values; there is no approaching-deadline trigger.                                                                                               | Merge PR #83, which reads the schedule from config and adds the due-soon reminder.                                                                                                                     |
| GRC-AUD-014 | Low      | Sessions                             | `src/lib/grc/repos/session.ts:93`                                                                                                                                                                                                                                                             | No idle timeout; a session is valid for the full 12 hours regardless of activity, though `last_seen_at` is already recorded.                                                                                                                                    | Enforce a sliding idle window (for example 60 minutes) alongside the absolute expiry.                                                                                                                  |
| GRC-AUD-015 | Low      | Hygiene                              | `src/pages/grc/affiliates.astro`, `users.astro`, `roles.astro`, `audit-universe.astro`                                                                                                                                                                                                        | Legacy top-level routes remain as 303 redirect stubs to the `/settings/*` screens. Harmless, but they inflate the route surface.                                                                                                                                | Keep them for one release for bookmarks, then remove them and the smoke entries together.                                                                                                              |

---

## 9. Appendices

### Appendix A: full route inventory

Thirty pages and forty API endpoints under `src/pages/grc`, from the
filesystem on the audited commit.

Pages:

| Route                                                | Purpose                                                | Gate                                                          |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `/login`                                             | Sign-in                                                | Public                                                        |
| `/change-password`                                   | Forced and voluntary password change                   | Session (exempt from the forced-change lock)                  |
| `/` (`index.astro`)                                  | Audit workbench dashboard                              | `can(read, AUDIT_WORKBENCH)`                                  |
| `/work-papers`                                       | Findings list with filters and search                  | `can(read, WORK_PAPER)`                                       |
| `/work-papers/new`                                   | Create finding                                         | `can(create, WORK_PAPER)`                                     |
| `/work-papers/[id]`                                  | Finding detail: tabs, workflow, evidence, requirements | `can(read, WORK_PAPER)`                                       |
| `/work-papers/[id]/edit`                             | Edit finding                                           | `can(update, WORK_PAPER)`                                     |
| `/action-plans`                                      | Table and kanban                                       | `can(read, ACTION_PLAN)`                                      |
| `/action-plans/new`                                  | Create plan                                            | `can(create, ACTION_PLAN)` or `can(create, AUDITEE_RESPONSE)` |
| `/action-plans/[id]`                                 | Plan detail, delegation, reviews                       | `can(read, ACTION_PLAN)`                                      |
| `/action-plans/[id]/edit`                            | Edit plan                                              | `can(update, ACTION_PLAN)`                                    |
| `/auditee-responses`                                 | Response queue (auditee and reviewer views)            | Session; rows scoped by assignment                            |
| `/auditee-responses/[id]`                            | Respond and review                                     | Session; assignment enforced                                  |
| `/reports`                                           | Report builder and preview                             | `can(read, REPORT)`; export button on `can(export, REPORT)`   |
| `/analytics`                                         | Charts                                                 | `can(read, WORK_PAPER)` or `can(read, REPORT)`                |
| `/notifications`                                     | In-app notification list                               | Session (user-scoped)                                         |
| `/send-queue`                                        | Queue and dead-letter monitor                          | Hard-coded SUPER_ADMIN                                        |
| `/settings`                                          | Settings home                                          | Hard-coded SUPER_ADMIN                                        |
| `/settings/general`                                  | Workflow and notification defaults                     | `can(read/update, CONFIG)` or SUPER_ADMIN                     |
| `/settings/affiliates`                               | Affiliate CRUD                                         | `can(read/update, CONFIG)` or SUPER_ADMIN                     |
| `/settings/users`                                    | User CRUD                                              | Hard-coded SUPER_ADMIN                                        |
| `/settings/audit-universe`                           | Areas and sub-areas with templates                     | `can(read, CONFIG)` or SUPER_ADMIN                            |
| `/settings/dropdowns`                                | Managed dropdown values                                | Hard-coded SUPER_ADMIN                                        |
| `/settings/access-control`                           | Role permission matrix editor                          | Hard-coded SUPER_ADMIN                                        |
| `/settings/ai`                                       | AI provider configuration                              | Feature flag plus hard-coded SUPER_ADMIN                      |
| `/settings/provision`                                | Provision a new organisation                           | Platform owner                                                |
| `/affiliates`, `/users`, `/roles`, `/audit-universe` | Legacy stubs                                           | 303 redirects to `/settings/*`                                |

API endpoints (grouped): auth (`login`, `logout`, `change-password`); work
papers (`index`, `[id]`, `[id]/delete`, `[id]/transition`,
`[id]/requirements`, `[id]/responsibles`); action plans (`index`, `[id]`,
`[id]/delete`, `[id]/transition`, `[id]/delegate`, `[id]/delegation`);
auditee responses (`submit`, `[id]/review`); evidence (`upload-url`,
`complete`, `[attachmentId]/download`, `[attachmentId]/delete`); reports
(`export`); AI (`config`, `test`, `insights`, `analytics`, `validate`);
setup (`affiliates`, `users`, `audit-universe`, `settings`); admin
(`access-control`, `dropdowns`, `organizations`, `send-queue/retry`);
shell (`notifications`, `sidebar-counts`, `org/switch`).

### Appendix B: linkage map (summary form)

```
work_papers (parent)
├── action_plans.work_paper_id            (nullable: GRC-AUD-005)
├── auditee_responses.work_paper_id       (+ action_plan_id, response_round)
├── work_paper_requirements.work_paper_id
├── work_paper_responsibles.work_paper_id (drives auditee visibility)
├── work_paper_revisions.work_paper_id    (workflow audit trail)
├── work_paper_cc_recipients.work_paper_id
├── file_attachments (entity_type='work_paper', entity_id)
│   └── files (carries organization_id; storage key under the tenant prefix)
├── legal_holds.entity_filter JSON        (naming the entity)
└── notification_queue / in_app_notifications.deep_link (route back to the finding)
```

### Appendix C: visibility matrix

Structural matrix (nine modules by six actions,
`src/lib/grc/auth/matrix.ts:14`-`26`); the per-role grants are live data in
`role_permissions`, edited at `/settings/access-control`, so a cell below
records who the code itself distinguishes, not the current database content.

| Module           | Actions available                             | Role behaviour fixed in code                                                                                                     |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| WORK_PAPER       | read, create, update, delete, approve, export | Submit follows update; approve and send follow approve (`matrix.ts:113`-`115`). No row-level scoping on the list (GRC-AUD-004)   |
| ACTION_PLAN      | same six                                      | Board and external roles see completed-side statuses only; non-auditors see owned plans only (`actionPlans.ts:96`)               |
| AUDITEE_RESPONSE | same six                                      | Auditee restricted to assigned findings (`auditeeResponses.ts:209`)                                                              |
| AUDIT_WORKBENCH  | same six                                      | Dashboard cards scoped per role                                                                                                  |
| REPORT           | same six                                      | Export separately gated on the export action (`api/reports/export.ts:36`); auditee report data unit-scoped (`reportData.ts:108`) |
| AI_ASSIST        | same six                                      | Also gated by the subscription feature flag (`hasFeature`)                                                                       |
| USER             | same six                                      | The users screen ignores the matrix today (GRC-AUD-006)                                                                          |
| CONFIG           | same six                                      | Three settings screens honour it, four ignore it (GRC-AUD-006)                                                                   |
| AUDIT_LOG        | same six                                      | No dedicated page yet; the grant is unused by any route                                                                          |

Role codes the code distinguishes outside the matrix: `SUPER_ADMIN` (full
matrix, hard-coded gates, Head-of-Audit notification CC at
`src/lib/grc/notify/recipients.ts:58`), `BOARD_MEMBER` and
`EXTERNAL_AUDITOR` (board-side visibility, `actionPlans.ts:82` and
`roleNav.ts:18`), and platform owners (`users.is_platform_owner`, full
matrix plus organisation switching, `src/middleware.ts:107`).
