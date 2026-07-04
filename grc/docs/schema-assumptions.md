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
| `permissions`              | `permission_code`                                                                                               | `src/lib/grc/auth/rbac.ts`                                   |
| `role_permissions`         | `role_code`, `permission_code`                                                                                  | `src/lib/grc/auth/rbac.ts`                                   |
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

`enum_values`, `status_transitions`, `workflow_terminal_states`, `roles`,
`permissions` and `role_permissions` define the product's workflow and access
model and are read without an `organization_id` filter (shared reference data).
Every tenant table is always scoped by the acting `organization_id`.

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
