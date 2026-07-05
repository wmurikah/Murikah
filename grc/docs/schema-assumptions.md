# GRC (hassaudit) schema assumptions

The `hassaudit` database is operator-managed: its schema-v2, the SaaS migration
and the bootstrap seed are applied outside this repo, and this foundation must
not change them. The prompt fixes most conventions; a few exact column names are
not stated, so this foundation makes the assumptions below and centralises the
SQL that depends on them, so reconciling with the real schema means editing one
module, not hunting through the app.

If a name here differs from the live schema, change it in the listed file only.

## Conventions fixed by the prompt (relied on directly)

- Tenancy is `organization_id` referencing `organizations(organization_id)`.
- Natural primary keys: `users.user_id`, `work_papers.work_paper_id`,
  `action_plans.action_plan_id`, `affiliates.affiliate_code`, `roles.role_code`.
- A user carries one role, `users.role_code`.
- Statuses are data-driven: `enum_values`, `status_transitions` (with
  `required_role` and `requires_comment`) and `workflow_terminal_states`.

## Assumed column names (reconcile if the live schema differs)

| Table                      | Columns used                                                                                                    | Where                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `users`                    | `user_id`, `email`, `password_hash`, `full_name`, `role_code`, `is_platform_owner`, `organization_id`, `status` | `src/lib/grc/repos/login.ts`, `src/lib/grc/repos/session.ts` |
| `organizations`            | `organization_id`, `name`, `status`                                                                             | `src/lib/grc/repos/login.ts`, `session.ts`, `orgContext.ts`  |
| `sessions`                 | `session_id`, `user_id`, `created_at`, `expires_at`                                                             | `src/lib/grc/repos/session.ts`                               |
| `roles`                    | `role_code`                                                                                                     | (reference)                                                  |
| `role_permissions`         | `role_code`, `module_code`, `action_code`, `is_allowed` (the matrix; see Build Prompt 12)                       | `src/lib/grc/auth/rbac.ts`                                   |
| `enum_values`              | `enum_type`, `value`, `sort_order`                                                                              | `src/lib/grc/workflow/transitions.ts`                        |
| `status_transitions`       | `enum_type`, `from_status`, `to_status`, `required_role`, `requires_comment`                                    | `src/lib/grc/workflow/transitions.ts`                        |
| `workflow_terminal_states` | `enum_type`, `status`                                                                                           | `src/lib/grc/workflow/transitions.ts`                        |
| `subscriptions`            | `organization_id`, `plan_code`, `status`                                                                        | `src/lib/grc/repos/features.ts`                              |
| `plans`                    | `plan_code`, `features_json`                                                                                    | `src/lib/grc/repos/features.ts`                              |
| `audit_log`                | `organization_id`, `user_id`, `action`, `details`, `created_at`                                                 | `src/lib/grc/repos/audit.ts`                                 |

## Passwords

Seeded hashes are PBKDF2. This foundation reads the stored format
`pbkdf2$<iterations>$<saltBase64>$<hashBase64>`, the same format the Murikah SaaS
migration writes, so seeded users verify without re-hashing
(`src/lib/grc/auth/password.ts`). If the seed uses a different encoding, adjust
`verifyPassword` there.

## Status values

Account and organisation status labels are matched leniently at sign-in: a
sign-in is refused only for an explicitly inactive value
(`INACTIVE`, `DISABLED`, `SUSPENDED`, `ARCHIVED`, `DELETED`), so an unexpected
active label never locks a valid user out (`src/pages/grc/api/auth/login.ts`).

## Reference vs tenant data

`enum_values`, `status_transitions`, `workflow_terminal_states`, `roles` and
`role_permissions` (the permission matrix) define the product's workflow and
access model and are read without an `organization_id` filter (shared reference
data). Every tenant table is always scoped by the acting `organization_id`.

## Work Papers module (Build Prompt 04)

The work-paper status enum type is assumed to be `WORK_PAPER_STATUS`, with the
values `DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`, `SENT_TO_AUDITEE`,
`RESPONSE_RECEIVED`, `RESPONSE_REVIEWED` and `REVISION_REQUIRED`
(`src/lib/grc/workflow/workPaperActions.ts`). The engine reads the actual allowed
transitions and `required_role`/`requires_comment` from `status_transitions`, so
only these string values and the enum type name are assumptions; the workflow
itself is data-driven. `RISK_RATING` uses the fixed set CRITICAL/HIGH/MEDIUM/LOW.

| Table                      | Columns used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `work_papers`              | `work_paper_id`, `organization_id`, `reference`, `status`, `revision_count`, `year`, `affiliate_code`, `audit_area_id`, `sub_area_id`, `work_paper_date`, `audit_period_from`, `audit_period_to`, `control_objectives`, `classification`, `control_type`, `control_frequency`, `standards`, `risk_description`, `test_objective`, `testing_steps`, `observation_title`, `observation_description`, `risk_rating`, `risk_summary`, `recommendation`, `management_response`, `assigned_auditor`, `prepared_by/at`, `submitted_by/at`, `reviewed_by/at`, `review_comments`, `approved_by/at`, `sent_to_auditee_by/at`, `created_by`, `created_at`, `updated_at` | `repos/workPapers.ts`, `workflow/workPaperWorkflow.ts` |
| `work_papers_fts`          | external-content FTS5 over `observation_title`, `observation_description`, `recommendation`, keyed by the `work_papers` rowid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `repos/workPapers.ts`                                  |
| `work_paper_revisions`     | `revision_id`, `organization_id`, `work_paper_id`, `revision_number`, `action`, `from_status`, `to_status`, `comments`, `changes_summary`, `user_id`, `user_name`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `repos/revisions.ts`                                   |
| `work_paper_requirements`  | `requirement_id`, `organization_id`, `work_paper_id`, `description`, `status`, `created_at`, `updated_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `repos/requirements.ts`                                |
| `work_paper_responsibles`  | `responsible_id`, `organization_id`, `work_paper_id`, `user_id`, `role_in_finding`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `repos/responsibles.ts`                                |
| `work_paper_cc_recipients` | `cc_id`, `organization_id`, `work_paper_id`, `user_id`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `repos/responsibles.ts`                                |
| `audit_areas`              | `audit_area_id`, `organization_id`, `name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `repos/workPaperLookups.ts`                            |
| `sub_areas`                | `sub_area_id`, `audit_area_id`, `organization_id`, `name`, `control_objectives`, `risk_description`, `test_objective`, `testing_steps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `repos/workPaperLookups.ts`                            |
| `affiliates`               | `affiliate_code`, `organization_id`, `name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `repos/workPaperLookups.ts`                            |
| `files`                    | `file_id`, `organization_id`, `file_name`, `mime_type`, `size_bytes`, `storage_backend`, `storage_key`, `uploaded_by`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `repos/evidence.ts`                                    |
| `file_attachments`         | `attachment_id`, `organization_id`, `file_id`, `entity_type`, `entity_id`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `repos/evidence.ts`                                    |
| `notification_queue`       | `notification_id`, `organization_id`, `template_code`, `entity_type`, `entity_id`, `status`, `created_by`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `repos/notify.ts`                                      |
| `enum_values`              | `value`, `label`, `sort_order` (label optional; falls back to humanising)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `repos/enums.ts`                                       |

Notes:

- The `reference` is generated as `WP-<year>-<random>` when the schema does not
  generate one; if the database assigns its own, drop the generated value in
  `repos/workPapers.ts`.
- FTS maintenance is best-effort (a create or edit never fails because the FTS
  shape differs); if the external-content contract differs, reconcile the sync in
  `repos/workPapers.ts`.
- Notification template codes beyond the confirmed `finding_shared` are
  assumptions (`finding_submitted`, `response_received`); enqueue is best-effort.
- Evidence bytes are not stored yet; only metadata is recorded. See
  `grc/docs/evidence-storage.md`.

## Action Plans module (Build Prompt 05)

The action-plan status enum type is assumed to be `ACTION_PLAN_STATUS`, with the
values `NOT_DUE`, `PENDING`, `IN_PROGRESS`, `OVERDUE`, `IMPLEMENTED`,
`PENDING_VERIFICATION`, `VERIFIED`, `CLOSED` and `REJECTED`
(`src/lib/grc/workflow/actionPlanActions.ts`). As with work papers, the allowed
moves and each transition's `required_role`/`requires_comment` are read from
`status_transitions`, so only these string values and the enum type name are
assumptions; validity is data-driven. The action catalogue is keyed by the
transition pair (`from>to`) because In Progress is reached two ways
(auditor return-for-rework and Head-of-Audit reject), which differ in permission
and effect.

Permissions used: `ACTION_PLANS.view`, `ACTION_PLANS.create`, `ACTION_PLANS.edit`,
`ACTION_PLANS.verify`, `ACTION_PLANS.close`, `AUDITEE.respond` and the optional
`ACTION_PLANS.evidence_override`.

| Table                 | Columns used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `action_plans`        | `action_plan_id`, `organization_id`, `action_number`, `work_paper_id`, `action_description`, `due_date`, `status`, `days_overdue`, `owner_ids`, `owner_names`, `auditee_proposed`, `implementation_notes`, `implemented_date`, `delegated_by_id`, `delegated_by_name`, `delegated_date`, `delegation_notes`, `delegation_accepted_date`, `original_owner_ids`, `auditor_review_comments`, `auditor_review_by`, `auditor_review_date`, `hoa_review_comments`, `hoa_review_by`, `hoa_review_date`, `created_by`, `created_at`, `updated_at` | `repos/actionPlans.ts`, `workflow/actionPlanWorkflow.ts`, `repos/overdue.ts` |
| `action_plan_owners`  | `owner_row_id`, `organization_id`, `action_plan_id`, `user_id`, `owner_type` (`ORIGINAL`/`CURRENT`), `is_active`, `added_at`, `removed_at`                                                                                                                                                                                                                                                                                                                                                                                                | `repos/actionPlanOwners.ts`                                                  |
| `action_plan_history` | `history_id`, `organization_id`, `action_plan_id`, `previous_status`, `new_status`, `comments`, `user_id`, `user_name`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                      | `repos/actionPlanHistory.ts`                                                 |

Notes:

- Owners are denormalised on `action_plans` as comma-delimited `owner_ids` and
  `owner_names`, kept in sync with the `action_plan_owners` junction through
  `setOwners`; the owner filter and the non-auditor visibility match against the
  delimited `owner_ids` (`',' || owner_ids || ','` LIKE), never an exact string.
- `action_number` is generated as `AP-<year>-<random>` when the schema does not
  assign one; if the database generates its own, drop the generated value in
  `repos/actionPlans.ts`.
- `delegation_accepted_date` marks a delegation as decided: it is set on accept
  and cleared (with the other delegation fields) on reject, so the accept/reject
  prompt shows only while a delegation is awaiting a decision.
- Overdue maintenance is a daily system job (`repos/overdue.ts`, wired into the
  worker's `scheduled()` daily cron): past-due active plans move to `OVERDUE` and
  `days_overdue` is refreshed. It runs across every organisation and is wrapped so
  a missing GRC binding or a schema difference never fails the engr crons.
- Notification template codes (`action_assigned`, `action_delegated`,
  `action_implemented`, `action_verified`, `action_returned`, `action_rejected`,
  `action_closed`) are assumptions; enqueue is best-effort.
- Evidence reuses the work-paper `files`/`file_attachments` seam with
  `entity_type = 'action_plan'`; bytes are still not stored (see
  `grc/docs/evidence-storage.md`).

## Board and BARC reporting (Build Prompt 07)

The reporting module adds no tables: it aggregates existing `work_papers` and
`action_plans` joined with `affiliates`, `audit_areas`, `work_paper_responsibles`
and `users`, and records generation and export in `audit_log`. Reads are scoped
by `organization_id` and by role.

Permissions used: `REPORTS.view` (see the page) and `REPORTS.board` (generate and
export a report). Audit actions written: `REPORT.generate` and `REPORT.export`.

Assumptions (reconcile in the listed module if the live schema differs):

- `users.affiliate_code` (nullable) is the UNIT_MANAGER's own affiliate, read
  defensively in `repos/reportData.ts` (`resolveUserAffiliate`): a schema without
  the column simply yields null, and the manager is then scoped by assignment
  alone rather than by affiliate. UNIT_MANAGER scoping is enforced server-side:
  observations where they are the `assigned_auditor` or a `work_paper_responsibles`
  row, and action plans whose `owner_ids` include them, within their affiliate.
- The risk buckets are Extreme, High, Medium and Low. The work-paper `risk_rating`
  may store the top band as CRITICAL, so `normaliseRisk` maps CRITICAL (and
  EXTREME) to the Extreme bucket (`reports/reportModel.ts`).
- The observation response status is derived, not stored: Responded when the
  work-paper status is `RESPONSE_RECEIVED`/`RESPONSE_REVIEWED` or a
  `management_response` is present, Awaiting response at `SENT_TO_AUDITEE`, else
  Not sent (`repos/reportData.ts`).
- An action plan is overdue when its due date has passed and its status is not
  settled; the settled set is Implemented, Pending Verification, Verified, Not
  Implemented, Closed and Rejected. Days overdue and days until due are computed
  from the due date, matching the source (`reports/reportModel.ts`).
- The Word export is generated with a dependency-free OOXML writer that runs on
  the Worker; see `grc/docs/reporting.md`.

## Dashboard, sidebar counts and navigation (Build Prompt 08)

The dashboard and the sidebar counts add no tables: they aggregate `work_papers`,
`action_plans` and `work_paper_responsibles` for the acting organisation, scoped
by role. Gate: `DASHBOARD.view`; the team-performance charts show only for
`HEAD_OF_AUDIT` and `SENIOR_AUDITOR`. The dashboard is read-only, so it writes no
audit rows; drill-through inherits the target module's gating.

Role sets (from the source, in `dashboard/roleNav.ts`):

- Auditee roles: `JUNIOR_STAFF`, `UNIT_MANAGER`, `SENIOR_MGMT`. Their sidebar and
  stat cards are scoped to their own items (GAP-510), and their default landing is
  their overdue action plans, or their findings when they have none.
- Team-performance roles: `HEAD_OF_AUDIT`, `SENIOR_AUDITOR`.
- Board roles (board reports, on top of the REPORTS permission): `BOARD_MEMBER`,
  `SUPER_ADMIN`. The clean `role_code = 'BOARD_MEMBER'` is used, not the source's
  BOARD/BOARD_MEMBER mismatch.

Assumptions and mappings:

- The four stat cards, the pending-reviews lists and the sidebar counts key off
  the work-paper statuses `SUBMITTED` (pending review), `SENT_TO_AUDITEE` (my
  observations, with a responsible), `APPROVED` (approved queue, with a
  responsible) and `RESPONSE_RECEIVED`, and the action-plan status
  `PENDING_VERIFICATION` (to verify).
- "Auditee response status Submitted" maps to the work-paper status
  `RESPONSE_RECEIVED` (a response has been received and awaits review); the round
  is `work_papers.revision_count`. A per-response submitter needs the auditee
  responses table, which this build does not add, so it is omitted.
- Overdue reuses the settled-status set from the reporting model
  (`NOT_OVERDUE_STATUSES`), so the dashboard, the sidebar and the reports agree.
- Action plans have no affiliate or audit area of their own (GAP-507): the
  affiliate-comparison chart joins through `work_paper_id` to
  `work_papers.affiliate_code`, never a field on the action plan.
- The clean columns are used directly (`status`, `created_at`, `updated_at`,
  `affiliate_code`, `role_code`, `is_platform_owner`); none of the source's
  data-quality workarounds (string booleans, empty timestamps, the role mismatch,
  the misnamed affiliate field) are reintroduced.
- The default landing is computed at sign-in (`repos/login.ts` now reads
  `role_code` and `is_platform_owner`); the sidebar counts refresh on every
  navigation (server-rendered) and on a light client poll of
  `/api/sidebar-counts`.

## Notifications and the send queue (Build Prompt 09)

The notification service (05_NotificationService.gs) and the send queue
(Sendqueue.html) run against the operator's aligned `notification_queue` and
`email_templates`. No schema change is made in the repo. The eighteen source
NOTIFICATION_TYPES and their per-type priority, in-app severity and HOA copy live
in `notify/types.ts`.

| Table                      | Columns used                                                                                                                                                                                                                                                                                                                           | Where                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `notification_queue`       | `notification_id`, `organization_id`, `batch_type`, `priority`, `channel`, `recipient_user_id`, `recipient_email`, `recipient_name`, `payload`, `related_entity_type`, `related_entity_id`, `rendered_subject`, `rendered_body`, `status`, `attempts`, `max_attempts`, `is_cc`, `error_message`, `sent_at`, `created_at`, `updated_at` | `notify/queue.ts`, `notify/dispatch.ts`, `repos/sendQueue.ts` |
| `in_app_notifications`     | `notification_id`, `organization_id`, `user_id`, `title`, `body`, `severity`, `link`, `read_at`, `created_at`                                                                                                                                                                                                                          | `notify/queue.ts`, `repos/inApp.ts`                           |
| `notification_dead_letter` | `notification_id`, `organization_id`, `batch_type`, `recipient_email`, `rendered_subject`, `error_message`, `attempts`, `created_at`                                                                                                                                                                                                   | `notify/dispatch.ts`, `repos/sendQueue.ts`                    |
| `email_templates`          | `template_type` (the NOTIFICATION type), `subject_template`, `body_template`, `is_active`                                                                                                                                                                                                                                              | `notify/queue.ts`                                             |

Notes:

- Every module still calls the same `enqueueNotification(templateCode, entity, actor)`;
  the adapter (`repos/notify.ts`) maps the code to a type, resolves the interested
  recipients (an action plan's owners, a work paper's assigned auditor and
  responsibles), builds the payload from the entity, queues one notification each,
  and copies the Head of Audit (all active SUPER_ADMIN, except the actor) on the
  key events. Enqueue is best-effort, so a schema difference never fails a
  transition.
- Rendering prefers an active `email_templates` row (`{{variable}}` interpolation
  from the payload) over the inline branded layout; both use navy `#1F2D5C` and the
  Hass Petroleum Group footer with replies to `audit@hasspetroleum.com`.
- Delivery is Microsoft Graph (Outlook) via the OAuth2 refresh-token flow, read
  from Worker secrets `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`,
  `OUTLOOK_REFRESH_TOKEN`, `OUTLOOK_SENDER_EMAIL` (and optional `OUTLOOK_TENANT`),
  gated by `GRC_ENV = 'production'`. Nothing is committed; when Graph is
  unconfigured or outside production the drain leaves rows PENDING.
- The scheduled Worker drains every run (urgent individually, normal batched per
  recipient into one digest), backs off between attempts (`updated_at` plus a
  growing delay) and moves a row to `notification_dead_letter` at `max_attempts`.
  Stale reminders run daily (deduplicated per work paper and recipient every three
  days), overdue reminders weekly (Mondays).
- The auditee responses table is not part of this build; RESPONSE_SUBMITTED is
  driven from the work-paper events the modules already enqueue.

## AI assistance and analytics (Build Prompt 10)

The AI service (05_AIService.gs) is ported as a unified `callAI` that routes to
the active provider over `fetch` (OpenAI chat completions, Anthropic messages
with the version header, Google generateContent) and logs every call. No schema
change is made in the repo: `ai_providers` and `ai_invocations` are assumed to
exist, and the non-secret settings live in the existing `config` table.

| Table            | Columns used                                                                                                                                                                                               | Where                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `ai_providers`   | `provider_id`, `organization_id`, `provider`, `created_at`                                                                                                                                                 | `ai/service.ts` (parent row) |
| `ai_invocations` | `invocation_id`, `organization_id`, `user_id`, `provider`, `model`, `purpose`, `related_entity_type`, `related_entity_id`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `success`, `created_at`   | `ai/service.ts` (per call)   |
| `config`         | `scope` (`GLOBAL`), `config_key` (`AI_%`), `config_value`, `updated_at`                                                                                                                                    | `ai/config.ts`               |
| `work_papers`    | read for insights (`observation_title`, `observation_description`, `risk_rating`, `recommendation`) and analytics (`status`, `risk_rating`, `affiliate_id`, `created_at`), all scoped by `organization_id` | `ai/*`, `repos/analytics.ts` |
| `action_plans`   | read for analytics (`status`, `due_date`, `created_at`), scoped by `organization_id`                                                                                                                       | `repos/analytics.ts`         |
| `affiliates`     | `affiliate_id`, `name`, joined for the by-affiliate chart within the same `organization_id`                                                                                                                | `repos/analytics.ts`         |
| `audit_log`      | a config change writes `AI.config`                                                                                                                                                                         | `api/ai/config.ts`           |

Notes:

- Provider API keys are held only as Worker secrets `AI_API_KEY_OPENAI`,
  `AI_API_KEY_ANTHROPIC`, `AI_API_KEY_GOOGLE_AI` (`ai/env.ts`). They are never
  written to the database and never returned to the client; the settings page
  shows only a masked tail. When the active provider's key is absent or the
  provider is disabled, `callAI` returns an error without contacting a provider.
- The non-secret settings are GLOBAL config keys: `AI_ACTIVE_PROVIDER`,
  `AI_MODEL`, `AI_MAX_TOKENS` (clamped 64 to 8000), `AI_TEMPERATURE` (clamped 0
  to 1), `AI_SYSTEM_PROMPT`, `AI_EVALUATION_ENABLED`, `AI_REJECTION_THRESHOLD`
  (0 to 100), and the per-provider flags `AI_ENABLED_OPENAI`,
  `AI_ENABLED_ANTHROPIC`, `AI_ENABLED_GOOGLE`. Config is platform-wide, so it is
  GLOBAL rather than org-scoped by design; a save updates then inserts each key
  so no unique constraint is assumed.
- Every invocation logs an `ai_invocations` row with the `purpose`
  (`WORK_PAPER_INSIGHTS`, `VALIDATE_ACTION_PLAN`, `EVALUATE_AUDITEE_RESPONSE`,
  `ANALYTICS_INSIGHTS`), the token counts and a success flag, ensuring the
  `ai_providers` parent row exists first. Logging is best-effort, so a schema
  difference never fails the call.
- The whole module is gated behind the subscription plan's `ai` feature
  (`ai/gate.ts`); provider configuration and connection tests are further
  restricted to SUPER_ADMIN (or a platform owner). Insights and validation are
  for auditor roles; the auditee auto-evaluation runs server-side on the
  action-plan create path (the auditee "propose" route), auto-rejecting a
  proposal below `AI_REJECTION_THRESHOLD` with feedback rather than creating it.
  When AI is disabled the SMART validation falls back to a non-AI check so the
  feature still works.
- Every AI output carries an advisory disclaimer (`AI_DISCLAIMER` in
  `ai/validation.ts`) that it is advisory only and must be checked against
  professional judgement. The model's Markdown is rendered with `textContent`
  (never as HTML) and CSS preserves its whitespace.

## Evidence storage on Cloudflare R2 (Build Prompt 11)

Evidence bytes are stored in Cloudflare R2 behind the storage seam
(`src/lib/grc/storage.ts`), with existing Google Drive files read through the same
seam and migrated in the background. The operator applied a schema patch adding
`storage_backend`, `storage_key`, `content_hash` and `content_hash_algo` to
`files`; the governance tables (`deletion_queue`, `legal_holds`,
`retention_policies`) are assumed to exist. No schema change is made in the repo.

| Table                | Columns used                                                                                                                                                                              | Where                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `files`              | `file_id`, `organization_id`, `file_name`, `mime_type`, `size_bytes`, `storage_backend`, `storage_key`, `content_hash`, `content_hash_algo`, `drive_file_id`, `uploaded_by`, `created_at` | `repos/evidence.ts`, `repos/governance.ts` |
| `file_attachments`   | `attachment_id`, `organization_id`, `file_id`, `entity_type` (`work_paper` or `action_plan`), `entity_id`, `created_at`                                                                   | `repos/evidence.ts`                        |
| `deletion_queue`     | `queue_id`, `organization_id`, `entity_type`, `entity_id`, `file_id`, `requested_by`, `reason`, `status` (`PENDING`), `retain_until`, `created_at`                                        | `repos/governance.ts`                      |
| `legal_holds`        | `organization_id`, `entity_type`, `entity_id`, `released_at` (NULL means active)                                                                                                          | `repos/governance.ts`                      |
| `retention_policies` | `organization_id`, `entity_type`, `retention_days`                                                                                                                                        | `repos/governance.ts`                      |

Notes:

- Keys are per-tenant and immutable:
  `org/{organization_id}/{entity}/{entity_id}/{file_id}/{safe_filename}`
  (`storage/keys.ts`). The `file_id` in the key equals `files.file_id`, so a
  replacement is a new id and a new key, never an overwrite. Every presign is
  guarded by `keyBelongsToOrg`, so a signed URL only ever reaches the acting
  tenant's prefix.
- Integrity: on completion the object is verified (R2 head) and its sha256 is
  computed server-side and stored on `content_hash`/`content_hash_algo`. Uploads
  and downloads use presigned URLs so the large bytes never stream through the
  worker; Drive-backed files are read through the worker instead.
- Access: an upload or download is allowed for a platform owner, for a holder of
  the entity's view/edit permission (`WORK_PAPERS.*`, `ACTION_PLANS.*`), or for an
  auditee personally linked to the entity: a work paper they are a responsible
  (`work_paper_responsibles`) or CC (`work_paper_cc_recipients`) on, or an action
  plan they own (`action_plan_owners`, `is_active = 1`) or raised
  (`action_plans.created_by`). This is the auditee-safe boundary on download.
- Deletion is soft and governed: a request inserts a PENDING `deletion_queue`
  row, is blocked outright when an unreleased `legal_holds` row covers the entity,
  and is stamped with the retention floor (now plus the longest matching
  `retention_policies.retention_days`) so the deferred purge honours retention.
  Nothing is hard-deleted in the request path. The hold check fails safe
  (blocked) rather than open.
- Migration: the daily `scheduled()` block migrates a batch of Drive-backed files
  (those whose entity is not under an active hold) to R2, updating
  `storage_backend`, `storage_key`, `content_hash` and `content_hash_algo` and
  keeping `drive_file_id` for provenance. `listDriveFilesToMigrate` is a
  system-wide maintenance query across every organisation, each file still keyed
  by its own `organization_id`, like the overdue refresh.
- Uploads, deletions, and holds that block a deletion are written to `audit_log`
  (`EVIDENCE.upload`, `EVIDENCE.delete_requested`, `EVIDENCE.delete_blocked_hold`).
- Secrets are Worker-only: the `EVIDENCE_BUCKET` binding, the R2 S3 presign
  credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`) and the read-only Drive credential (`GDRIVE_CLIENT_ID`,
  `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`). All optional; when absent the
  seam reports storage is not configured and the app is otherwise unaffected.

## RBAC matrix, dropdowns and provisioning (Build Prompt 12 addenda)

The RBAC note in the foundation is superseded: the permission model is a matrix,
not a permission-code list (PermissionService.gs). The operator applied
`grc-permissions-fix.sql` and `grc-reference-seed.sql`; no schema change is made
in the repo.

| Table              | Columns used                                                                                                                  | Where                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `role_permissions` | `role_code`, `module_code`, `action_code`, `is_allowed`                                                                       | `auth/rbac.ts`, `repos/permissionsAdmin.ts`    |
| `roles`            | `role_code`                                                                                                                   | `repos/permissionsAdmin.ts`                    |
| `config`           | `scope` (an `organization_id`), `config_key` (`DROPDOWN_*` and Phase 1 keys), `config_value`, `updated_at`                    | `repos/dropdowns.ts`, `repos/provisioning*.ts` |
| `audit_areas`      | `audit_area_id`, `organization_id`, `name`, `is_active`, `display_order`                                                      | `repos/workPaperLookups.ts`                    |
| `sub_areas`        | `sub_area_id`, `audit_area_id`, `organization_id`, `name`, template fields, `is_active`, `display_order`                      | `repos/workPaperLookups.ts`                    |
| `affiliates`       | `affiliate_code`, `organization_id`, `name`, `is_active`, `display_order`                                                     | `repos/workPaperLookups.ts`                    |
| `organizations`    | `organization_id`, `name`, `status`, `created_at`                                                                             | `repos/provisioning.ts`                        |
| `users`            | `user_id`, `organization_id`, `email`, `full_name`, `password_hash`, `role_code`, `is_platform_owner`, `status`, `created_at` | `repos/provisioning.ts`                        |
| `subscriptions`    | `organization_id`, `plan_code`, `status`, `created_at`                                                                        | `repos/provisioning.ts`                        |

Notes:

- The matrix is `{ module: { action: boolean } }` built from `role_permissions`
  (`auth/matrix.ts`, pure and unit-tested), cached per role in the isolate and
  invalidated on a grant change. The modules are `WORK_PAPER`, `ACTION_PLAN`,
  `AUDITEE_RESPONSE`, `AUDIT_WORKBENCH`, `REPORT`, `AI_ASSIST`, `USER`, `CONFIG`,
  `AUDIT_LOG`; the actions are `read`, `create`, `update`, `delete`, `approve`,
  `export`. Two source aliases apply before lookup: action `view` maps to `read`,
  and module `WORK_PAPERS` maps to `WORK_PAPER`. `can(locals, action, module)` is
  the server-side gate; `PAGE_PERMISSION_MAP` maps a page slug to its required
  module and action. `role_permissions` and `roles` are shared reference data
  (not tenant data), so they are not organisation-scoped; the acting `role_code`
  is authoritative.
- A SUPER_ADMIN and a platform owner hold the full matrix and are never modified.
  The access-control screen (`settings/access-control.astro`) shows each role's
  matrix and its resulting page access and writes grants to `role_permissions`
  (`repos/permissionsAdmin.ts`), invalidating the cache; a legacy permission-code
  list is derived from the matrix so earlier `perms.includes` checks keep working,
  matrix-driven.
- The work-paper control fields and risk rating are managed dropdowns from
  per-organisation config: `DROPDOWN_RISK_RATINGS`,
  `DROPDOWN_CONTROL_CLASSIFICATION`, `DROPDOWN_CONTROL_TYPE`,
  `DROPDOWN_CONTROL_FREQUENCY`, each a JSON array under `scope = organization_id`
  (`repos/dropdowns.ts`), cached and invalidated on change and manageable by a
  SUPER_ADMIN (`settings/dropdowns.astro`); `standards` stays free text. Audit
  areas, sub-areas and affiliates are filtered to `is_active` and ordered by
  `display_order` then name.
- Creating a new organisation seeds its defaults automatically in one
  transactional batch (`repos/provisioning.ts`, with the pure builder in
  `provisioningDefaults.ts`): the Phase 1 config, the reference dropdowns, a first
  `SUPER_ADMIN` user (password hashed with `auth/password.ts`, never stored plain)
  and a trial subscription (`plan_code = 'trial'`). The defaults live in one place
  in code, in step with the seed scripts. Provisioning is a platform-owner action
  (`api/organizations.ts`, `settings/provision.astro`).
