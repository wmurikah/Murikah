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
