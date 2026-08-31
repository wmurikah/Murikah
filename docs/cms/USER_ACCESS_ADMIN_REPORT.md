# User administration: job title, access roles, permission preview, mappings

Scope: user administration only. No change to authentication or session
architecture, no RBAC weakening, no deployment setting, and no redesign of any
other CMS module.

## The conceptual model, unchanged

Four things stay four things. Nothing was merged, and nothing derives access
from a job title:

| Concept            | What it is                                        | Where it lives                                      |
| ------------------ | ------------------------------------------------- | --------------------------------------------------- |
| Job title          | organisational position. Grants nothing, anywhere | `job_titles`, via `user_assignments`                |
| Access role        | application permissions                           | `access_roles` → `role_permissions` → `permissions` |
| Permission         | a capability belonging to a role                  | `permissions`                                       |
| Workflow authority | what a person may approve in a process            | `workflow_roles` → `workflow_role_assignments`      |

The resolver still walks `user_roles → access_roles → role_permissions →
permissions` and nothing else. A test asserts that `src/lib/cms/auth/rbac.ts`,
`src/lib/cms/permissions.ts` and `src/lib/cms/workflow/model.ts` contain no
reference to either mapping table.

## Schema

**Reused, unchanged:** `users`, `user_assignments`, `job_titles`,
`access_roles`, `user_roles`, `user_role_scopes`, `role_permissions`,
`permissions`, `workflow_roles`, `workflow_role_assignments`, `audit_events`.
Nothing was rebuilt or backfilled.

**Added, additive:** two catalogue tables, in
`docs/cms/users/13_job_title_mappings.sql` and registered in
`docs/cms/SCHEMA_REGISTER.md`:

- `job_title_access_role_mappings` — `UNIQUE(job_title_id, role_id)`, FKs to
  `job_titles`, `access_roles`, `users`
- `job_title_workflow_role_mappings` — `UNIQUE(job_title_id, workflow_role_id)`,
  FKs to `job_titles`, `workflow_roles`, `users`

Both start empty. Nothing is inferred from existing users: their assignments
and roles remain authoritative.

**No direct user permission system was created.** There is no
`user_permissions` and no `job_title_permissions`; the migration's verification
query (c) fails if either ever appears. A permission belongs to a role, so a
role cannot say NO while an override says YES.

## Edit User

The Edit tab is now two sections: **Person** (the existing form, unchanged, and
still posting only to the user endpoint) and **Position & access**, a new
`CmsUserAccessPanel`.

| Control                     | Present | How                                                                                           |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| Job title dropdown          | **Yes** | `job_titles`, stores `job_title_id`, displays `title_name`, no free text                      |
| Access role selector        | **Yes** | current roles as chips with their scopes; Add role reuses the existing scope-requiring drawer |
| Permission preview          | **Yes** | grouped by module, readable labels, raw code in a `title` tooltip                             |
| Workflow authority selector | **Yes** | separate section, separate drawer, separate permission                                        |

Changing the title **supersedes** the current primary assignment: the old row is
ended (`effective_to` = today, `active` = 0) and a new one is inserted with the
same department, level and location. `updateAssignment` already refuses to
rewrite a level or a location under the stated rule that a historical row is
never rewritten, and a title is the same kind of fact — updating the column
would make "who was the Credit Controller in March" unanswerable. A person with
no current assignment cannot have a title set here; the control says so and
points at the Assignments tab, because a department and a level cannot be
derived from a title and inventing an organisational placement is worse than
asking for one.

**Assignments, Roles and Workflow authority tabs are all kept.** Edit is
current-state administration; those are the history, with the effective dates
and superseded rows.

## Job title mappings

Under Administration → Users → Job titles, gated on `ADMIN.ROLES.MANAGE`:

| Access role mapping | Workflow role mapping |
| ------------------- | --------------------- |
| **Yes**             | **Yes**               |

Two separate tables and two separate columns on screen. Each mapped access role
shows its permission count with the full list one disclosure away, so an
administrator sees what a default would grant before saving it. Everything is a
dropdown; no id is typed.

## Applying a mapping — and why it cannot escalate

Setting a job title writes an assignment and **nothing else**. The response
returns the title's defaults so the screen can offer them; applying them is a
separate request through `POST /api/admin/users/{id}/apply-title-defaults`, and
four things make it safe:

1. **Every line is opt-in.** Each default arrives unticked. Apply is disabled
   until every ticked line has a scope.
2. **Every grant carries a scope the administrator chose.** Nothing defaults to
   GROUP. Where the person's own posting gives an obvious answer the control is
   pre-filled with it and still shown; a Group-level posting pre-fills nothing.
3. **The claim is re-derived server-side.** Every role id is checked against the
   title's actual mapping. A role that is not a default for that title is
   refused by name, however the payload was produced.
4. **Two permissions, checked separately** against what the request asks for:
   `ADMIN.ROLES.MANAGE` for the access half, `ADMIN.WORKFLOW_ROLES.MANAGE` for
   the authority half. Asking for both without holding both is refused whole.

Roles already held are **retained**, not re-granted: the scope somebody chose
deliberately is never overwritten. Manual roles are never removed because a
title changed — no code anywhere revokes on a title.

## Authorization

Server-side, on every endpoint, before any row is read or written:

| Endpoint                                          | Permission                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `PUT /api/admin/users/{id}/job-title`             | `ADMIN.USERS.MANAGE`                                                |
| `POST/PATCH/DELETE /api/admin/job-title-mappings` | `ADMIN.ROLES.MANAGE`                                                |
| `POST /api/admin/users/{id}/apply-title-defaults` | `ADMIN.ROLES.MANAGE` and/or `ADMIN.WORKFLOW_ROLES.MANAGE`, per half |
| `POST /api/admin/users/{id}/roles`                | `ADMIN.ROLES.MANAGE` (unchanged)                                    |
| `POST /api/admin/workflow-roles/{id}/assignments` | `ADMIN.WORKFLOW_ROLES.MANAGE` (unchanged)                           |

A viewer holding only `ADMIN.USERS.MANAGE` sees roles and authority as
read-only lists. That is presentation; the endpoints refuse independently.

**Self-escalation.** New, and enforced in the repositories at the only routes
into `user_roles` and `workflow_role_assignments`:

- an administrator cannot assign themselves an access role, reactivate a lapsed
  one of their own, or replace their own scopes;
- an administrator cannot give themselves approval authority.

Giving up your own role is still allowed — it takes access away, and the
existing last-administrator guard decides whether the removal is survivable.
The subject is compared against the session's actor, never against anything in
the payload. The screen hides both Add controls on your own record, which is
presentation; the refusal is the control.

## Audit

Existing architecture, existing `audit_events` table, existing helper. Events
written: `JOB_TITLE_CHANGED` (with both assignment ids and before/after titles),
`JOB_TITLE_ROLE_MAPPING_CREATED` / `_UPDATED` / `_REMOVED`,
`JOB_TITLE_WORKFLOW_MAPPING_CREATED` / `_UPDATED` / `_REMOVED`. Role and scope
events (`USER_ROLE_ASSIGNED`, `ROLE_SCOPE_ASSIGNED`, and their removals) were
already written by the existing paths, which is what the new surfaces call.

## Transaction safety

A role and its scopes are written in one `db.batch([...], 'write')` — that
pairing can never be separated, which is the one the brief singles out. The
title change ends the old assignment, inserts the new one and writes its audit
row in one batch. Applying several defaults pre-checks everything that can be
checked (subject exists, not self, every role mapped and live, already-held
skipped) before the first write, so the run does not abandon halfway on a
predictable refusal.

## Validation

| Command                                                     | Result                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm run build`                                            | **PASS** — `astro check` 0 errors, 0 warnings; server and client built                           |
| `pnpm lint`                                                 | **PASS** — 0 errors, 15 warnings, all pre-existing on `main` in files this change does not touch |
| `node --experimental-strip-types --test test/cms/*.test.ts` | **857 / 857 pass**, 0 fail                                                                       |
| `git diff --check`                                          | clean                                                                                            |
| `pnpm exec prettier --check src test docs`                  | all files match                                                                                  |

New tests: `test/cms/userAccessAdmin.test.ts` (24) covering the job title
dropdown, the supersede-not-rewrite lifecycle, "a title change grants no role
and no authority", multi-role assignment with scopes preserved, the permission
preview union, removal semantics, both self-escalation refusals, the mapping
catalogue and its audit rows, and the apply-defaults validator. Extended:
`test/cms/rbacAuth.test.ts` (per-endpoint authorization, including the split
capability check on apply-defaults and the self-refusal), and
`test/cms/editScreens.test.ts`.

Screenshots taken against the seeded organisation at 1440 and 430 px: the Edit
tab, the same tab viewed by its own subject, and the Job titles page. Horizontal
overflow −15 px at every viewport.

## Deployment settings

**NOT CHANGED.** No Cloudflare build, deploy or version command, no project or
wrangler setting, no production branch setting, no CI configuration.
