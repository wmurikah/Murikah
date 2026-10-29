# Merge reconciliation report

Date: 2026-08-07. Build Prompt 30, executed on the integration branch
`claude/module-build-standards-3s3hw0` at commit `0631947` (merge of PR #94).

Six overlapping fix branches (PRs #88 to #93) and the follow-up PR #94 were
merged into the integration branch; earlier merges had silently dropped hunks
in the files several branches share. This reconciliation compared every
delivered branch tip against the integration HEAD, line by line, and verified
every delivered item by its feature code, not only by the tests.

## Method

For each delivered feature commit, every file it changed was compared against
the integration HEAD as a line set: any line present on the branch but absent
at HEAD was flagged and reviewed by hand. Flags fell into exactly two classes:
intended supersessions (a later branch deliberately replaced the earlier
code) and genuine drops. Section 3 then verified each item's feature code
directly, because untested code can vanish without a red build.

A scope correction: the prompt listed Prompts 27 and 29 as not yet merged.
Both are in fact merged (PR #91 at `1e8d1d7`, PR #93 at `f975760`), so their
content was verified with everything else rather than skipped.

## Findings summary

Nothing is missing. Every drop from the original six-way merge had already
been restored by PR #94 (the middleware MFA enrolment lock, the forgot- and
reset-password smoke steps, five branches' round-trip blocks, the settings
step that had been blanking `MFA_REQUIRED_ROLES`, and the enrolment-lock
smoke check), and the line-set comparison found no further drops. The one
overlap the coverage gate could never have caught, the Prompt 27 and
Prompt 28 edits to the same action-plan create and edit surfaces, resolved
as a correct union: the parent-finding requirement and the rich-text editor
and evidence staging all coexist.

The whole suite is green on the reconciled branch: `pnpm lint`,
`pnpm build`, `pnpm test` (309 tests, every round-trip block and the
MFA-lock check included) and `pnpm format:check`.

## Item-by-item verification

Status: Present (verified intact at HEAD) or Dropped-and-restored (restored
by PR #94, verified still present). Nothing required restoration in this
pass.

| Item                                                                                | Status                                          | Evidence at integration HEAD                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reset request endpoint answers neutrally, single-use hashed token, 45-minute expiry | Present                                         | `src/pages/grc/api/auth/forgot-password.ts` (one `neutral()` answer for every path); `src/lib/grc/repos/passwordReset.ts:25` (`RESET_TOKEN_TTL_MINUTES = 45`), token stored as SHA-256 hash only                              |
| Reset dispatch through the send queue                                               | Present                                         | `forgot-password.ts` calls `queueNotification` with the `PASSWORD_RESET` type; link built by `passwordResetLink` (`src/lib/grc/notify/links.ts`)                                                                              |
| Reset rate-limiting per email and per IP                                            | Present                                         | `allowResetRequest` (`src/lib/grc/auth/resetRateLimit.ts`) plus the durable per-user cap `countRecentResetRequests`                                                                                                           |
| Reset screen validates the token; reset invalidates all sessions                    | Present                                         | `src/pages/grc/reset-password.astro` (pre-check via `findValidResetToken`); `applyPasswordReset` batch includes `DELETE FROM sessions` (`passwordReset.ts:164`)                                                               |
| "Forgot your password?" link on the login page                                      | Present                                         | `src/pages/grc/login.astro` links `/forgot-password`                                                                                                                                                                          |
| `[grc.auth.reset]` failure tagging                                                  | Present                                         | Both reset endpoints log under the tag                                                                                                                                                                                        |
| Sign-in footer wording                                                              | Present                                         | `src/layouts/GrcAuthLayout.astro:51` reads "Risk Intelligence &amp; Analytics"; "A Murikah product" absent from the GRC layout; wordmark, headline and sub-line untouched; `CmsAuthLayout.astro` keeps its own wording        |
| MFA enrolment lock enforced in the middleware                                       | Dropped-and-restored (PR #94), verified present | `src/middleware.ts` uses `isGrcMfaEnrolExempt`, `mfaRequiredForRole`, `parseMfaRecord`; imports all used, none dangling                                                                                                       |
| Pending-session confinement                                                         | Present                                         | `src/middleware.ts` (`mfa === 'pending'` admits only the step, its endpoint and sign-out)                                                                                                                                     |
| TOTP enrolment and verification routes                                              | Present                                         | `src/pages/grc/mfa.astro`, `mfa/setup.astro`, `api/auth/mfa/{enrol,confirm,verify}.ts` all present and wired                                                                                                                  |
| Unenrolled user under an ALL rule bounced to `/mfa/setup`                           | Dropped-and-restored (PR #94), verified present | Smoke block "an unenrolled user under a required rule is locked to enrolment"                                                                                                                                                 |
| Login throttling                                                                    | Present                                         | `api/auth/login.ts` wires `failureStreaks` and `throttleDecision`; lockouts recorded in `security_events`                                                                                                                     |
| Idle timeout beside the absolute expiry                                             | Present                                         | `resolveSession` applies `sessionLiveness` (`src/lib/grc/auth/sessionRules.ts`, 60-minute window)                                                                                                                             |
| The eleven surfaces gate on the matrix, not the literal role                        | Present                                         | `grep "roleCode === 'SUPER_ADMIN'"` over `src/pages/grc` finds only `api/access-control.ts:32`, which checks the submitted form's role to refuse modifying SUPER_ADMIN's own matrix (deliberate behaviour, not an actor gate) |
| PAGE_PERMISSION_MAP matches the real routes and is enforced                         | Present                                         | `src/lib/grc/auth/matrix.ts` (no phantom slugs); `src/middleware.ts` enforces `pageAccess(matrix, pageSlugForPath(appPath))` centrally                                                                                        |
| `listWorkPapers` viewer row-scoping                                                 | Present                                         | `src/lib/grc/repos/workPapers.ts` takes `WorkPaperViewer`; rules in `workPaperVisibility.ts`                                                                                                                                  |
| Rich-text editor on the narrative fields                                            | Present                                         | `GrcRichText` on all eight `WorkPaperForm.astro` fields, the action-plan forms and the auditee response and review forms                                                                                                      |
| Marks rendered into DOCX                                                            | Present                                         | `src/lib/grc/reports/docx/wordml.ts` (`parseRichText`, `richBlockXml`, inline runs in list items)                                                                                                                             |
| Evidence staging on create, bound on save                                           | Present                                         | `work_paper_draft` and `action_plan_draft` on the presign and complete endpoints; `bindDraftAttachments` called from both create endpoints; `GrcDraftEvidence` on both create forms                                           |
| Forgot- and reset-password smoke steps                                              | Dropped-and-restored (PR #94), verified present | `grc/test/smoke.test.ts` MUTATION_STEPS                                                                                                                                                                                       |
| The five restored round-trip blocks                                                 | Dropped-and-restored (PR #94), verified present | Parent enforcement and orphan relink; Markdown rendering; draft-evidence binding; lockout; idle session; full reset round trip; three MFA blocks: all present, in the dependency-safe order (reset before MFA)                |
| Settings step no longer blanks `MFA_REQUIRED_ROLES`                                 | Dropped-and-restored (PR #94), verified present | The step posts the full pre-filled form with `MFA_REQUIRED_ROLES: 'NONE'` and verifies the stored value                                                                                                                       |
| Seed data the blocks depend on                                                      | Present                                         | `grc/test/smoke/seed.ts`: lockout user, `MFA_REQUIRED_ROLES` config, orphan plan, UNIT_MANAGER grants                                                                                                                         |
| Prompt 27 (merged, verified though listed out of scope)                             | Present                                         | `checkActionPlanInput`, server-side parent verification on create and edit, `listOrphanActionPlans` and the orphan panel                                                                                                      |
| Prompt 29 (merged, verified though listed out of scope)                             | Present                                         | `expect`/`verify` step annotations throughout the smoke test; provisioning statements target the live schema (`org_code`/`org_name`, `subscription_id`, `organization_id`-scoped config); legacy stubs absent                 |

## Supersessions confirmed as intended (not drops)

The line-set comparison flagged these; each is a later branch deliberately
replacing earlier code, and the replacement is the version verified above:

| Earlier branch content absent at HEAD                                                       | Superseded by                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The original "delete the created work paper" success step and the "In Progress" Kanban drop | Prompt 29's reworked steps: a submitted finding's delete is asserted as a refusal, a disposable draft proves the delete path, and the drop closes the verified plan        |
| `readSessionId` in the middleware session read                                              | Prompt 25's `readGrcSessionCookie`, which also carries the MFA state                                                                                                       |
| The two-path `PUBLIC_GRC_PATHS` set                                                         | Prompt 24's expanded set including the forgotten-password screens and endpoints                                                                                            |
| The plain textareas on the action-plan forms                                                | Prompt 28's `GrcRichText`                                                                                                                                                  |
| The "Not linked to a finding" option and the create endpoint's old validation               | Prompt 27's required "Choose the parent finding" select and `checkActionPlanInput`, now coexisting with Prompt 28's draft-evidence binding (the union verified explicitly) |
| Minor comment wording in two smoke blocks                                                   | PR #94's restored blocks carry equivalent comments                                                                                                                         |

## Not restored

Nothing. No delivered hunk remains missing.
