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
