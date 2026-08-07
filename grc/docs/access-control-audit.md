# Access-control and tenancy audit (Build Prompt 40)

A read-only audit of the access-control, RBAC and tenancy-scoping subsystem of
the GRC product (Assurance OS). No application code, schema or config was
changed by this audit; this report is the only file it adds.

> **Status note (Build Prompt 43).** AC-03, AC-04, AC-05 and AC-06 have since
> been fixed and are recorded here as history, not as open findings. The role
> save is one atomic `db.batch` with its own error handling; the module list and
> the seed both read `PERMISSION_MODULES` from `src/lib/grc/auth/matrix.ts`, and
> the save reconciles the `permission_modules` and `permission_actions` lookup
> rows in the same batch, so it is self-healing on any database; the matrix cache
> became a shared, explicitly invalidated store with a five second cap in Build
> Prompt 42, and the smoke run now proves an access change reaches an already
> open session on its next request; and the smoke database enforces the
> permission keys, so the foreign-key violation that shipped now fails the test.
> AC-01, AC-02, AC-07, AC-08, AC-09 and AC-10 remain open.

Audited at commit `8e659d5` (merge of Build Prompt 39). Conventions are those in
`grc/docs/module-build-standards.md`: the `role_permissions` matrix,
`can(locals, action, module)`, `PAGE_PERMISSION_MAP`, the acting-organisation
resolution and `users.is_platform_owner`.

Two things this audit could not do, stated up front so nothing below is read as
stronger than it is:

- **The live schema is not in the repository.** `grc/db/schema.md` is a column
  dictionary only. It records no primary keys, foreign keys, NOT NULL or CHECK
  constraints. Where a finding depends on a constraint, this report says so and
  gives the exact query that settles it.
- **No live database access.** Every claim is drawn from source, and the
  reproduction in section 2 is a code trace, not an observed run.

---

## 1. Executive summary

The per-request tenancy scoping is in good shape. Every user-facing list a
non-platform admin can reach is scoped by the acting `organization_id`, and the
acting organisation itself is resolved server-side from the session on every
request and never from a request parameter. The sweep in section 3 found no
list that leaks another organisation's rows. That is the headline good news, and
it means the reported symptom (a non-platform admin seeing users beyond their
organisation) is almost certainly **not** a query-scoping bug. Section 3.4 sets
out what it is instead.

What is broken is narrower and sharper than a scoping leak, and in one respect
more serious:

**The permission model itself is not tenant data.** `role_permissions`, `roles`,
`enum_values` and `status_transitions` are platform-wide tables with no
`organization_id` column, and the screens that edit them are reachable by any
instance admin holding `CONFIG.update`. When the Hass administrator edits the
AUDITOR role, they are editing the AUDITOR role **for every customer on the
platform**. The same is true of the platform-wide AI provider configuration and
the shared Outlook mail connection, both of which hang off a `GLOBAL` sentinel
organisation. This is a genuine cross-tenant control problem, and it will get
worse with every instance added.

**The role-save `internal_error` is a foreign-key violation on an unguarded
write loop**, and the loop is not transactional, so the save that "fails" has in
fact already applied about three quarters of its changes. Section 2 traces it.

**A permission change does not reliably take effect on the next request.** The
matrix is cached in a module-level `Map` per Worker isolate with no TTL and no
cross-isolate invalidation. The save invalidates only the isolate that happened
to serve the save. Every other isolate serves the stale matrix until it is
recycled, which is why a permission change can appear not to apply.

Top issues by severity:

| Rank | ID    | Severity | Issue                                                                                     |
| ---- | ----- | -------- | ----------------------------------------------------------------------------------------- |
| 1    | AC-01 | Critical | The permission matrix is platform-wide; an instance admin edits every tenant's roles      |
| 2    | AC-02 | Critical | Platform-wide AI config and the shared Outlook mailbox are writable by any instance admin |
| 3    | AC-03 | High     | Role save throws an unhandled error and half-applies; `{"error":"internal_error"}`        |
| 4    | AC-04 | High     | Matrix cache is per-isolate with no TTL; permission changes do not propagate              |
| 5    | AC-05 | High     | `MODULES` in code has drifted from the live `permission_modules` rows                     |
| 6    | AC-06 | Medium   | The smoke harness cannot catch constraint violations at all                               |
| 7    | AC-07 | Medium   | Access granularity is module-by-action only; no per-entity or per-affiliate grant         |
| 8    | AC-08 | Low      | The organisation line shows a redundant "Organisation" super-label                        |
| 9    | AC-09 | Low      | Cross-tenant email existence probe on the users screen                                    |

---

## 2. The role-save `internal_error`

### 2.1 The path

1. `/settings/access-control` (`src/pages/grc/settings/access-control.astro`)
   renders a checkbox per module and action from the **code's** `MODULES` and
   `ACTIONS` constants (imported at `access-control.astro:18-19`, defined at
   `src/lib/grc/auth/matrix.ts:14-26`).
2. The form posts to `/api/setup/../access-control`, handled by
   `src/pages/grc/api/access-control.ts`.
3. That endpoint loops every module and action and writes each grant
   (`api/access-control.ts:39-44`):

   ```ts
   const db = await getDb(getGrcEnv()); // line 38
   for (const module of MODULES) {
     // line 39
     for (const action of ACTIONS) {
       // line 40
       const allowed = form.get(`grant_${module}_${action}`) === '1';
       await setGrant(db, roleCode, module, action, allowed); // line 42
     }
   }
   invalidateRoleMatrix(roleCode); // line 45
   ```

4. `setGrant` (`src/lib/grc/repos/permissionsAdmin.ts:47-67`) is an
   UPDATE-then-INSERT upsert:

   ```sql
   UPDATE role_permissions SET is_allowed = ?
     WHERE role_code = ? AND module_code = ? AND action_code = ?
   -- if rowsAffected === 0:
   INSERT INTO role_permissions (role_code, module_code, action_code, is_allowed)
   VALUES (?, ?, ?, ?)
   ```

### 2.2 Why the error is opaque

The write loop at `api/access-control.ts:39-44` has **no `try`/`catch`**. The
only `try` in the file is around the audit write at line 46, which is explicitly
best-effort. Anything the loop throws therefore propagates out of the route,
into the middleware's last-resort boundary
(`src/middleware.ts:195-200` calling `grcErrorResponse`), which for an API path
returns exactly:

```json
{ "error": "internal_error" }
```

with status 500 (`src/lib/grc/errorBoundary.ts:44-50`). That is the reported
string, and it is the _proximate_ cause of the opacity: the real reason is
written to the Worker log by `logGrcError` under the tag
`grc.api.access-control`, but the caller is told nothing.

**This part is certain.** Whatever the underlying throw is, this is how it
surfaces.

### 2.3 The root cause of the throw

Foreign keys are enforced. `src/lib/grc/db.ts:22` runs, on every connection:

```ts
await client.execute('PRAGMA foreign_keys = ON;');
```

with the comment "Foreign keys are turned on for the connection, since libSQL
leaves them OFF per connection". So any `REFERENCES` clause in the live schema
bites.

`role_permissions` sits alongside two lookup tables that exist for no other
purpose (`grc/db/schema.md:55-56, 62`):

```
- **permission_actions**: action_code, action_name
- **permission_modules**: module_code, module_name, description
- **role_permissions**: role_code, module_code, action_code, is_allowed
```

The module list the code writes has drifted from the list the database holds.
Compare:

| `src/lib/grc/auth/matrix.ts:14-24` (what the endpoint writes) | `grc/test/smoke/seed.ts:118-128` (the recovered live list) |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| WORK_PAPER                                                    | WORK_PAPER                                                 |
| ACTION_PLAN                                                   | ACTION_PLAN                                                |
| AUDITEE_RESPONSE                                              | AUDITEE_RESPONSE                                           |
| AUDIT_WORKBENCH                                               | AUDIT_WORKBENCH                                            |
| REPORT                                                        | REPORT                                                     |
| AI_ASSIST                                                     | AI_ASSIST                                                  |
| USER                                                          | NOTIFICATION                                               |
| **CONFIG**                                                    | **SETUP**                                                  |
| **AUDIT_LOG**                                                 | USER                                                       |

`grc/test/smoke/seed.ts` is the hand-written reconstruction of the live
reference data. It carries `NOTIFICATION` and `SETUP`; the code carries `CONFIG`
and `AUDIT_LOG`. Both lists are nine long, which is what let the divergence go
unnoticed.

**Root cause:** if `role_permissions.module_code` references
`permission_modules(module_code)`, then the INSERT for `CONFIG` violates that
foreign key, libSQL throws, and the loop dies. `permission_modules` cannot
contain `CONFIG` or `AUDIT_LOG` rows if the seed reflects the live table, so the
UPDATE at `permissionsAdmin.ts:55` always affects zero rows for those modules
and the INSERT at line 61 is always attempted. The failure is therefore
deterministic: **every role save fails, every time**, for any role but
SUPER_ADMIN (which returns early at `api/access-control.ts:32`).

**The one query that settles it**, run against the live `hassaudit` database:

```sql
SELECT sql FROM sqlite_master WHERE name = 'role_permissions';
SELECT module_code FROM permission_modules ORDER BY module_code;
SELECT action_code FROM permission_actions ORDER BY action_code;
```

If the first returns a `REFERENCES permission_modules` clause and the second
omits `CONFIG` and `AUDIT_LOG`, the diagnosis above is confirmed exactly. If
there is no foreign key, the throw is something else and the log line under
`[grc.api.access-control]` names it; the fix in 2.5 is required either way,
because it is what makes that log line reach the administrator.

Two lesser candidates, listed for completeness and ranked below the above:

- **Subrequest exhaustion.** The loop issues nine modules times six actions =
  54 sequential `db.execute` calls, each a separate HTTPS request to Turso from
  `@libsql/client/web`, plus a second INSERT round trip per missing row (up to
  108), plus the `PRAGMA` at `db.ts:22`, the session resolve, the matrix load
  and the subscription load. Cloudflare Workers cap subrequests per request
  (50 on the Free plan, 1000 on Paid). On a Free-plan Worker this alone would
  throw. Independent of plan, 54 to 108 serial round trips is a poor shape for
  one form submission.
- **A NOT NULL or CHECK constraint** on a `role_permissions` column the INSERT
  at `permissionsAdmin.ts:62` does not supply. The dictionary shows only four
  columns and all four are supplied, so this is unlikely, but the dictionary
  does not record constraints.

### 2.4 The write is not transactional, and half-applies

This matters more than the error message. `MODULES` is iterated in declaration
order, so before the `CONFIG` grant is reached the loop has already committed
seven modules times six actions = **42 grants**, each as its own autocommitted
statement. The administrator sees `internal_error` and reasonably concludes
nothing was saved. In fact three quarters of the change is live, and the
remaining twelve grants (`CONFIG` and `AUDIT_LOG`) are not. The role is left in
a state the administrator never chose and cannot see, because the screen reloads
from the database and shows the partially-applied result as though it were
intended.

`libsql` exposes `db.batch(statements, 'write')`, which the codebase already
uses elsewhere (for example `src/lib/grc/repos/evidence.ts:95-130`). The role
save does not use it.

### 2.5 The precise fix (not applied)

Three changes, in order of importance:

1. **`src/pages/grc/api/access-control.ts:39-44`** - replace the 54-iteration
   sequential loop with a single `db.batch([...], 'write')` so the save is one
   atomic round trip. This removes the partial-write window, the subrequest
   exposure and 53 network round trips at once.
2. **`src/pages/grc/api/access-control.ts:38-45`** - wrap the write in
   `try`/`catch`, log under a `[grc.access-control]` tag, and redirect back to
   `/settings/access-control?role=...&error=...` with a message the
   administrator can act on, matching how every other Setup endpoint behaves
   (for example `src/pages/grc/api/setup/users.ts:187-190`). No Setup mutation
   should ever be able to reach the middleware's last-resort boundary.
3. **`src/lib/grc/auth/matrix.ts:14-24`** - reconcile `MODULES` with the live
   `permission_modules` rows. This is a data-versus-code decision, not a free
   choice: per `grc/db/schema.md:5-7`, "the database is the recovered source of
   truth: the code is bound to it, not the other way round". Either add
   `CONFIG` and `AUDIT_LOG` rows to `permission_modules` (and decide what
   `NOTIFICATION` and `SETUP` mean, since no code reads them), or rename the
   code's modules to match. Whichever way, `grc/test/smoke/seed.ts:118-128` must
   be brought into step in the same commit, and the two lists should be
   generated from one source so they cannot drift again.

---

## 3. Tenancy scoping

### 3.1 How the acting organisation is resolved

`src/middleware.ts:120-147`. An ordinary user, instance admin included, is
pinned to `identity.homeOrganizationId` from the DB-backed session
(`src/lib/grc/repos/session.ts:74-126`); no cookie is read for them and no
switch is possible. Only `users.is_platform_owner = 1` causes the acting-org
cookie to be consulted, and the requested id is validated against the live list
of active organisations (`src/lib/grc/repos/orgContext.ts:53-83`) before it is
honoured. This is sound: the acting organisation can never come from a request
parameter, and a tampered cookie resolves to no instance rather than to any
organisation.

### 3.2 The surface sweep

Every list and query a non-platform admin can reach was checked. Method: extract
every SQL literal under `src/lib/grc/repos/**` and `src/pages/grc/api/**`,
identify the tenant tables each touches, and check for an `organization_id`
predicate, then read every hit by hand to rule out false positives from
interpolated `WHERE` builders.

| Surface                                 | Repo function                                                    | Scoped      | Evidence                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| Users list                              | `listUsers`                                                      | Yes         | `usersAdmin.ts:59` `WHERE ${U.organization_id} = ?`                                               |
| User read for writes                    | `getManagedUser`                                                 | Yes         | `usersAdmin.ts:92`                                                                                |
| User create / update / activate / reset | `createUser`, `updateUser`, `setUserActive`, `resetUserPassword` | Yes         | `usersAdmin.ts:154, 186, 209, 226` all carry `organization_id = ?`                                |
| Assignable auditors dropdown            | `listAuditors`                                                   | Yes         | `workPaperLookups.ts:46`                                                                          |
| Action-plan owner names                 | `resolveOwnerRefs`                                               | Yes         | `actionPlanOwners.ts:92-93`                                                                       |
| Work-paper responsibles                 | `listResponsibles`                                               | Yes         | `responsibles.ts:35` joins `work_papers ... AND wp.organization_id = ?`                           |
| CC recipients add                       | `addCcRecipient`                                                 | Yes         | `responsibles.ts:124` `EXISTS (... organization_id = ?)`                                          |
| Work papers list                        | `listWorkPapers`                                                 | Yes         | `workPapers.ts:185` plus row scope via `workPaperVisibility.ts`                                   |
| Work paper detail / transition          | `getWorkPaper`, transition endpoint                              | Yes         | org id threaded from `locals.grc`                                                                 |
| Action plans list and detail            | `listActionPlans`                                                | Yes         | `actionPlans.ts:136` and the viewer scope at `:96-102`                                            |
| Auditee responses                       | `auditeeResponses.ts`                                            | Yes         | 13 `organization_id` predicates across 16 statements                                              |
| Reports data                            | `reportData.ts`                                                  | Yes         | `:105` `wp.organization_id = ?`, plus affiliate scope at `:113`                                   |
| Affiliates                              | `affiliatesAdmin.ts`                                             | Yes         | org id on every read and write                                                                    |
| Audit universe                          | `auditUniverse.ts`                                               | Yes         | org id on areas and sub-areas                                                                     |
| Notifications (in-app bell)             | `inApp.ts`                                                       | User-scoped | `api/notifications.ts:18-20` scopes by `grc.userId`; correct, the table has no `organization_id`  |
| Send queue list and counts              | `listQueue`, `getQueueCounts`                                    | Yes         | `sendQueue.ts:68` `organization_id = ?`, `:36`                                                    |
| Send queue dead letter                  | `listDeadLetter`                                                 | Yes         | `sendQueue.ts:119` via the joined queue row                                                       |
| Send queue retry                        | `retryRow`                                                       | Yes         | `sendQueue.ts:144` `AND ${Q.organization_id} = ?`                                                 |
| Dashboard cards and panels              | `dashboard.ts`                                                   | Yes         | every builder seeds `args` with `organizationId` (for example `:107-116`, `:224-231`, `:270-289`) |
| Analytics                               | `analytics.ts`                                                   | Yes         | org id on every aggregate                                                                         |
| Evidence download                       | `getAttachmentForAccess`                                         | Yes         | `api/evidence/[attachmentId]/download.ts:29`, plus a storage-key prefix check at `:45`            |
| Dropdowns save                          | `saveDropdown`                                                   | Yes         | `dropdowns.ts:110` writes `config` scoped by org                                                  |
| Org settings                            | `orgConfig.ts`                                                   | Yes         | `:76`, `:93`                                                                                      |

**No leaking list was found.** Four statements touch tenant tables without an
`organization_id` predicate; all four were read and all four are correct:

- `overdue.ts:22, 30` - a deliberate platform-wide maintenance UPDATE run from
  the Worker's `scheduled()` handler, documented as such at `overdue.ts:4-6`.
  Not reachable from a user request.
- `loginAttempts.ts:69, 79` - lockout counting by email and by IP, which must
  span organisations to work.
- `workPapers.ts:389` - an FTS `rowid` lookup by the unique `work_paper_id`,
  best-effort index maintenance only.
- `evidence.ts:115` - `file_attachments` has no `organization_id` column
  (`grc/db/schema.md:37`); tenancy is carried by the joined `files` row, which
  is scoped.

### 3.3 The one deliberate cross-organisation read

`emailInUse` (`src/lib/grc/repos/usersAdmin.ts:122-134`) queries `users` with
no organisation predicate, by design and correctly: sign-in resolves a user by
email alone across every instance (`repos/login.ts:22-35`), so an address held
in one organisation must not be reusable in another. The side effect is that an
instance admin can probe whether any address exists anywhere on the platform, by
attempting to create a user and reading the refusal, which names the address.
Low severity, but it is a cross-tenant information disclosure and the message
could be neutral instead (AC-09).

### 3.4 So why would an admin see users beyond their organisation?

The code cannot produce that symptom through the Users screen: `listUsers` is
scoped at `usersAdmin.ts:59` and the acting organisation for a non-platform user
is their home organisation, resolved server-side and unswitchable. Three
explanations remain, in order of likelihood:

1. **The `is_platform_owner` flag is set on the wrong row.** This is data, not
   code, and it was flagged during Build Prompt 38 (`grc/docs/tenancy.md`,
   "Deployment note"). If the customer's administrator account carries
   `is_platform_owner = 1`, then the code correctly treats them as the platform
   owner: they get `fullMatrix()` (`middleware.ts:153-156`), the instance
   switcher, the all-instances view listing every customer by name, and the
   ability to enter any organisation and see its users. Every symptom described
   follows from that one row. **Check first:**
   `SELECT user_id, email, organization_id, is_platform_owner FROM users WHERE is_platform_owner = 1;`
   That should return exactly one row, the Murikah Labs account.
2. **`users.organization_id` is wrong or NULL on some rows.** A NULL never
   matches `organization_id = ?`, so those users would _disappear_ rather than
   leak; but a row carrying the wrong organisation id would appear in the wrong
   list. **Check:**
   `SELECT organization_id, COUNT(*) FROM users WHERE deleted_at IS NULL GROUP BY organization_id;`
3. **The observation predates Build Prompt 38.** Before that change a platform
   owner defaulted silently into their home organisation with a switcher
   available, which made the two roles hard to tell apart in the interface.

This is the honest answer: the audit found no code path that leaks users, and
the most probable cause is a single misplaced flag. Until the first query above
is run, the symptom should not be treated as fixed.

### 3.5 The real cross-tenant problem: the permission model is global

`role_permissions` has no `organization_id` column (`grc/db/schema.md:62`), and
`src/lib/grc/repos/permissionsAdmin.ts:2-5` states the position plainly:

> The permission model is shared reference data (not tenant data), keyed by
> role_code, module_code and action_code, so this is not organisation-scoped.

That was a defensible choice for a single-tenant deployment. It is not one for a
platform with more than one customer. The gate on the save endpoint is
`grc.isPlatformOwner || can(locals, 'update', 'CONFIG')`
(`api/access-control.ts:23-26`), and a customer's SUPER_ADMIN holds the full
matrix (`middleware.ts:153-156`), so **every instance admin can rewrite the
permission matrix of every role for every organisation on the platform.** An
administrator at one customer can grant `WORK_PAPER.read` to `JUNIOR_STAFF` and
change what junior staff can see at every other customer simultaneously. There
is no audit isolation either: the change is recorded against the acting
organisation (`api/access-control.ts:46-53`) although its effect is global.

The same shape applies to:

- `roles` (`schema.md:63`) - platform-wide, read by `listRoleCodes`
  (`permissionsAdmin.ts:13-29`).
- `enum_values`, `status_transitions`, `workflow_terminal_states`
  (`schema.md:30, 58, 68`) - platform-wide workflow definitions.
- The AI provider configuration, deliberately keyed to a `GLOBAL` sentinel
  organisation (`src/lib/grc/ai/config.ts:23`, `:88-94`), writable through
  `/api/ai/config` on the same `CONFIG.update` gate (`api/ai/config.ts:24`).
- The Outlook mail connection, also on the `GLOBAL` sentinel
  (`src/lib/grc/repos/orgConfig.ts:114`, `repos/mailConnection.ts:5`), writable
  through `/api/admin/outlook/connect` (`connect.ts:27`). One customer's admin
  can disconnect or replace the mailbox every customer's notifications send
  from.

This is AC-01 and AC-02, and they are the most serious findings in this report.

---

## 4. The permission model: storage, resolution, immediacy

### 4.1 Storage

`role_permissions(role_code, module_code, action_code, is_allowed)`. A user
carries exactly one role, `users.role_code`; there is no `user_roles` junction.
Grants are therefore role-level and platform-level, never user-level or
organisation-level.

### 4.2 Resolution

Per request, in `src/middleware.ts:153-157`:

```ts
const matrix =
  identity.isPlatformOwner || identity.roleCode === 'SUPER_ADMIN'
    ? fullMatrix()
    : await getPermissionMatrix(db, identity.roleCode);
const perms = deriveLegacyPerms(matrix);
```

`fullMatrix()` (`matrix.ts:131-138`) grants everything and touches no database
row, so **SUPER_ADMIN and platform owners never read `role_permissions` at
all**. Their access is hard-coded in the middleware, which is why an
administrator testing a permission change against their own account will see no
effect whatever the matrix says. Everyone else gets a real matrix build.

`can(locals, action, module)` (`rbac.ts:47-50`) reads `locals.grc.matrix` and
applies two aliases before lookup (`matrix.ts:30-31`): action `view` maps to
`read`, module `WORK_PAPERS` maps to `WORK_PAPER`. `deriveLegacyPerms`
(`matrix.ts:167-169`) projects the matrix onto older string codes such as
`WORK_PAPERS.view` so pre-matrix call sites stay matrix-driven.

Central page enforcement is real and does run: `middleware.ts:188-190` calls
`pageAccess(matrix, pageSlugForPath(appPath))` before the page renders, and the
slugs in `PAGE_PERMISSION_MAP` (`matrix.ts:63-89`) now match the deployed
routes. A previous audit recorded this map as decorative and the Setup screens
as hard-coded role checks; both have since been fixed. The only remaining literal
role comparison in the codebase is the deliberate SUPER_ADMIN protection at
`api/access-control.ts:32`. There are 47 `can(...)` call sites across
`src/pages/grc`.

### 4.3 Caching, and the immediacy answer

**A permission change does not reliably take effect on the next request.**

The cache is a module-level `Map` in `src/lib/grc/auth/rbac.ts:19`:

```ts
const matrixCache = new Map<string, PermissionMatrix>();
```

`getPermissionMatrix` (`rbac.ts:22-38`) returns the cached matrix if present and
otherwise loads and stores it. There is **no TTL and no size bound**: once a
role is cached in an isolate it is never re-read.

`invalidateRoleMatrix(roleCode)` (`rbac.ts:41-44`) deletes the entry, and
`api/access-control.ts:45` calls it after the save. But a module-level `Map` in
a Cloudflare Worker lives in **one isolate**. Cloudflare runs many isolates
across many colos, created and recycled on demand. The invalidation therefore
clears the cache in precisely the one isolate that served the save request, and
nowhere else. Every other isolate continues to serve the stale matrix for the
whole of its life.

Consequences, in the order an administrator meets them:

- The administrator saves a change and tests it themselves. They are SUPER_ADMIN
  or platform owner, so they hold `fullMatrix()` and see no difference at all.
- They ask an affected user to check. That user's request lands on whichever
  isolate the load balancer picks. If it is the one that served the save, the
  change appears. If it is any other, it does not. The behaviour looks random
  and reproduces intermittently.
- The change eventually appears everywhere, once every isolate holding the old
  value has been recycled. That interval is not under the application's control
  and is not observable from inside it.

Note that the save currently fails anyway (section 2), so today the cache
question is masked. Fixing the save without fixing the cache will surface this
immediately as "I changed it and it did not apply".

There are two further caches of the same shape, both lower risk because their
data is less sensitive: the dropdown cache
(`src/lib/grc/repos/dropdowns.ts`, invalidated per organisation at
`api/dropdowns.ts:42`) and the Graph access-token cache
(`src/lib/grc/notify/sendMail.ts:55`, which does at least carry an expiry).

**Against best practice.** The standard expectation is that an authorisation
change applies on the next request, everywhere, and that authorisation state is
either read fresh or held in a store all instances share. Neither holds here. The
options, cheapest first:

1. **Drop the cache.** `getPermissionMatrix` is one indexed SELECT on a small
   table, and the request already makes several. This is one line, is correct by
   construction, and is almost certainly the right answer at this scale.
2. **Add a short TTL** (30 to 60 seconds) so staleness is bounded and
   self-healing even without invalidation. Cheap, and a reasonable compromise if
   the query ever becomes hot.
3. **Move the cache to a shared store** (Workers KV, or a `permissions_version`
   counter row read per request and compared against the cached version). Correct
   and immediate, but it reintroduces a per-request read, which makes option 1
   the simpler way to the same place.

Recommendation: option 1, with option 2 as the fallback if measurement ever
justifies a cache.

---

## 5. The organisation label

`src/layouts/GrcLayout.astro:83`:

```ts
const orgLabel = inInstance ? 'Organisation' : 'Platform';
```

rendered at `:163-166` as a two-line block:

```astro
<div class="grc-orgline">
  <p class="grc-orgline__label">{orgLabel}</p>
  <p class="grc-orgline__name">{orgName}</p>
</div>
```

**Current behaviour.** A non-platform instance admin always has
`instanceSelected === true` (`middleware.ts:130`, never set false for a
non-owner), so they see the literal word "Organisation" above their organisation
name, on every page. The platform owner sees "Platform" above "All
organisations" until they enter an instance, then "Organisation" above that
instance's name.

**The gap.** For an instance admin the super-label carries no information. They
belong to exactly one organisation, cannot switch, and have no second context to
disambiguate from; the label states a category the user already knows and costs a
line of vertical space in the sidebar on every screen. The name alone is what
they need. For the platform owner the label does real work, because it
distinguishes "you are above the customers" from "you are inside one".

**Recommended (not applied):** render the label only when the viewer has more
than one context, that is `grc.isPlatformOwner === true`, and render the name
alone otherwise. One conditional at `GrcLayout.astro:83` and `:164`. This is
cosmetic, hence Low, but it is on the screen a customer sees most.

---

## 6. Granularity: what exists, and what the owner wants

### 6.1 Current granularity

Two dimensions, and no more:

- **Module by action.** Nine modules (`matrix.ts:14-24`) by six actions
  (`matrix.ts:26`), a 54-cell grid per role.
- **Role.** One role per user (`users.role_code`), eight roles seeded.

Everything else is hard-coded row-level logic inside individual repositories,
which is real defence in depth but is not configurable by an administrator:

- Work papers: `workPaperVisibility.ts` splits auditor-side (sees the whole
  organisation) from auditee-side (sees only findings they are assigned to or
  named responsible for), and hides Drafts from everyone but the author,
  preparer and assigned auditor.
- Action plans: `actionPlans.ts:96-102` scopes by role and ownership.
- Reports: `reportData.ts:105-116` scopes a unit manager to their own findings
  **and their affiliate**.
- Auditee responses: scoped to assigned findings.

So the answer to "how fine-grained is it" is: coarse where an administrator can
configure it, and fine where they cannot.

### 6.2 What is not currently possible

The stated want is access scoped to a specific entity, affiliate or record, so
that an individual or a group can be granted access to one thing rather than to
a whole module. None of that is expressible today:

- A grant cannot name an affiliate. `WORK_PAPER.read` is all-or-nothing across
  the organisation; there is no way to say "the Kenya affiliate only".
- A grant cannot name a record. There is no per-entity ACL table.
- A grant cannot name a user. Grants attach to roles only, so giving one person
  an exception means minting a whole role for them.
- A user cannot hold two roles, so capabilities cannot be composed.

### 6.3 What the schema already supports

More than might be expected. `affiliate_code` is already carried on five tables
(`grc/db/schema.md`):

| Table          | Column                               |
| -------------- | ------------------------------------ |
| `users`        | `affiliate_code`                     |
| `work_papers`  | `affiliate_code`                     |
| `action_plans` | `affiliate_code`                     |
| `departments`  | `affiliate_code`                     |
| `affiliates`   | `affiliate_code` (the entity itself) |

A user's affiliate is already read (`reportData.ts:37-51`) and already used as a
security scope in exactly one place: the unit-manager report scope
(`reportData.ts:112-116`). The work-paper and action-plan lists treat
`affiliate_code` only as a user-chosen filter (`workPapers.ts:185`,
`actionPlans.ts:136`), not as an enforced boundary.

**This is the important finding for this section: per-affiliate scoping needs no
new schema.** The column is on the users and on the records. What is missing is
a flag saying "this role is confined to its user's affiliate", and the six or so
repository call sites that would honour it.

### 6.4 Recommended direction

Incremental, each step useful on its own, ordered by value over cost.

**Step 1: make the permission matrix tenant-scoped.** Nothing else on this list
is safe until this is done, because every step below adds more that one
customer's admin can change for another's. Add `organization_id` to
`role_permissions`, defaulting existing rows to a platform-default row set that
new organisations inherit at provisioning time
(`repos/provisioningDefaults.ts` already seeds per-organisation defaults and is
the natural home). Resolve as: the organisation's own row if present, else the
platform default. This is the prerequisite, and it fixes AC-01.

**Step 2: add an affiliate-confinement flag to the role.** One boolean, for
example `roles.scope_to_affiliate`, or a `SELF_AFFILIATE` scope column on
`role_permissions`. When set, the repositories append
`AND <table>.affiliate_code = ?` using the viewer's `users.affiliate_code`. This
delivers "a group can be granted access to their affiliate rather than the whole
organisation" using columns that already exist, at roughly six call sites
(`workPapers.ts`, `actionPlans.ts`, `auditeeResponses.ts`, `reportData.ts`
which already does it, `dashboard.ts`, `analytics.ts`). Highest value for the
cost, by a distance.

**Step 3: allow more than one role per user,** via a `user_roles` junction with
the matrix resolved as the union of the roles held. This turns roles into
composable capabilities and removes the need to mint a bespoke role for every
exception. Moderate cost: `users.role_code` is read in many places and would
need a compatibility path.

**Step 4: per-entity grants, only where a real workflow needs them.** A narrow
`entity_grants(organization_id, entity_type, entity_id, subject_type,
subject_id, action, granted_by, granted_at, expires_at)` table, consulted as an
additive exception after the role matrix denies. Keep it additive, never
subtractive, so the role matrix stays the thing an administrator can reason
about. Introduce it for one entity type first, most likely work papers, where
"share this one finding with this one person" is a genuine need.

**What to avoid.** A general attribute-based policy engine, where rules are
written against arbitrary attributes and evaluated at request time, is the
textbook answer and the wrong one here. It is hard to reason about, hard to show
in a user interface an auditor can review, and the audit trail question ("why
could this person see this?") becomes a policy-evaluation trace rather than a
row an administrator can read. The role matrix plus an affiliate scope plus
narrow additive exceptions covers the stated need, stays legible on the
access-control screen, and each step is independently shippable.

---

## 7. Findings register

| ID    | Severity | Area                           | File or route                                                                                                                                             | Description                                                                                                                                                                                                     | Recommended fix                                                                                                                                                                   |
| ----- | -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | Critical | Multi-tenancy, RBAC            | `src/lib/grc/repos/permissionsAdmin.ts:2-5`, `grc/db/schema.md:62`, `src/pages/grc/api/access-control.ts:23-26`                                           | `role_permissions` has no `organization_id`, so any instance admin holding `CONFIG.update` rewrites every role for every customer on the platform                                                               | Add `organization_id` to `role_permissions`; resolve as the organisation's rows falling back to a platform default; seed per organisation at provisioning                         |
| AC-02 | Critical | Multi-tenancy, config          | `src/lib/grc/ai/config.ts:23`, `src/lib/grc/repos/orgConfig.ts:114`, `src/pages/grc/api/ai/config.ts:24`, `src/pages/grc/api/admin/outlook/connect.ts:27` | The platform-wide AI provider config and the shared Outlook mail connection sit on a `GLOBAL` sentinel and are writable by any instance admin, affecting every tenant                                           | Gate every `GLOBAL`-scoped write on `isPlatformOwner` alone, or move the mail connection and AI config per organisation                                                           |
| AC-03 | High     | Error handling, data integrity | `src/pages/grc/api/access-control.ts:39-44`                                                                                                               | The role-save loop has no `try`/`catch` and no transaction: it surfaces as `{"error":"internal_error"}` and leaves 42 of 54 grants applied                                                                      | Wrap in `db.batch(..., 'write')` for atomicity, catch and redirect with a real message, log under `[grc.access-control]`                                                          |
| AC-04 | High     | RBAC, caching                  | `src/lib/grc/auth/rbac.ts:19-44`                                                                                                                          | The matrix cache is a per-isolate `Map` with no TTL; `invalidateRoleMatrix` clears only the saving isolate, so permission changes propagate unpredictably                                                       | Remove the cache (one indexed SELECT), or add a 30 to 60 second TTL                                                                                                               |
| AC-05 | High     | Reference data                 | `src/lib/grc/auth/matrix.ts:14-24` vs `grc/test/smoke/seed.ts:118-128`                                                                                    | `MODULES` carries `CONFIG` and `AUDIT_LOG`; the live `permission_modules` appears to carry `NOTIFICATION` and `SETUP`. With `PRAGMA foreign_keys = ON` (`db.ts:22`) this makes every role save fail             | Reconcile code to the database per `schema.md:5-7`; generate both lists from one source so they cannot drift                                                                      |
| AC-06 | Medium   | Test coverage                  | `grc/test/smoke/fakeTurso.ts:106`                                                                                                                         | The smoke database creates every table with untyped columns and no constraints, so no foreign key, NOT NULL or CHECK violation can ever be caught before deploy. AC-03 and AC-05 both pass the smoke test today | Emit key constraints (at minimum the permission foreign keys) in the generated smoke schema, or add a migration-checked DDL file as ground truth alongside `schema.md`            |
| AC-07 | Medium   | Authorisation granularity      | `src/lib/grc/auth/matrix.ts:14-26`, `users.role_code`                                                                                                     | Grants are module-by-action and role-only: no per-affiliate, per-record or per-user grant, and one role per user                                                                                                | Section 6.4: tenant-scope the matrix, then add an affiliate-confinement flag using the existing `affiliate_code` columns, then multi-role, then narrow additive per-entity grants |
| AC-08 | Low      | Interface                      | `src/layouts/GrcLayout.astro:83, 164`                                                                                                                     | An instance admin sees a redundant "Organisation" super-label above their only organisation's name                                                                                                              | Render the label only when `grc.isPlatformOwner`; show the name alone otherwise                                                                                                   |
| AC-09 | Low      | Information disclosure         | `src/lib/grc/repos/usersAdmin.ts:122-134`, `src/pages/grc/api/setup/users.ts:136, 155`                                                                    | The deliberate cross-platform email-uniqueness check lets an instance admin probe whether an address exists in another organisation, and the refusal names it                                                   | Keep the check, neutralise the message ("that address cannot be used")                                                                                                            |
| AC-10 | Info     | Deployment data                | `users.is_platform_owner`                                                                                                                                 | The reported "admin sees users beyond their organisation" symptom is most likely a misplaced `is_platform_owner` flag rather than a code defect (section 3.4)                                                   | Run `SELECT user_id, email, organization_id, is_platform_owner FROM users WHERE is_platform_owner = 1;` and confirm it returns only the Murikah Labs account                      |

---

## 8. Appendix

### A. Surfaces checked, with scoping status

Reads and writes reachable by a non-platform instance admin. "Scoped" means the
statement carries an `organization_id` predicate bound to `locals.grc.organizationId`.

| #   | Surface                            | Route or repo                                             | Scoped                                            |
| --- | ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| 1   | Users list                         | `settings/users.astro` to `usersAdmin.listUsers`          | Yes                                               |
| 2   | User create                        | `api/setup/users.ts` op `create`                          | Yes                                               |
| 3   | User update                        | `api/setup/users.ts` op `update`                          | Yes                                               |
| 4   | User activate / deactivate         | `api/setup/users.ts`                                      | Yes                                               |
| 5   | User reset password                | `api/setup/users.ts` op `reset_password`                  | Yes                                               |
| 6   | Temporary-password handoff         | `repos/tempPasswordHandoff.ts`                            | Yes, and bound to the acting admin                |
| 7   | Email uniqueness probe             | `usersAdmin.emailInUse`                                   | Deliberately platform-wide, see AC-09             |
| 8   | Work papers list                   | `work-papers.astro`                                       | Yes, plus row scope                               |
| 9   | Work paper detail                  | `work-papers/[id].astro`                                  | Yes                                               |
| 10  | Work paper create / edit           | `api/work-papers/*`                                       | Yes                                               |
| 11  | Work paper transition              | `api/work-papers/[id]/transition.ts`                      | Yes                                               |
| 12  | Work paper requirements            | `repos/requirements.ts`                                   | Yes                                               |
| 13  | Work paper responsibles            | `repos/responsibles.ts`                                   | Yes                                               |
| 14  | CC recipients                      | `repos/responsibles.ts:120-127`                           | Yes                                               |
| 15  | Action plans list                  | `action-plans.astro`                                      | Yes, plus role scope                              |
| 16  | Action plan detail                 | `action-plans/[id].astro`                                 | Yes                                               |
| 17  | Action plan create / edit          | `api/action-plans/*`                                      | Yes                                               |
| 18  | Action plan transition             | `api/action-plans/[id]/transition.ts`                     | Yes                                               |
| 19  | Action plan delegate               | `api/action-plans/[id]/delegate.ts`                       | Yes                                               |
| 20  | Action plan owners                 | `repos/actionPlanOwners.ts`                               | Yes                                               |
| 21  | Action plan history                | `repos/actionPlanHistory.ts`                              | Yes                                               |
| 22  | Auditee responses queue            | `auditee-responses.astro`                                 | Yes, plus assignment scope                        |
| 23  | Auditee response detail and review | `api/auditee-responses/*`                                 | Yes                                               |
| 24  | Reports                            | `reports.astro` to `repos/reportData.ts`                  | Yes, plus affiliate scope for unit managers       |
| 25  | Report export                      | `api/reports/export.ts`                                   | Yes                                               |
| 26  | Analytics                          | `analytics.astro`                                         | Yes                                               |
| 27  | Dashboard stats, panels, charts    | `index.astro` to `repos/dashboard.ts`                     | Yes                                               |
| 28  | Sidebar counts                     | `api/sidebar-counts.ts`                                   | Yes                                               |
| 29  | Affiliates                         | `settings/affiliates.astro`, `repos/affiliatesAdmin.ts`   | Yes                                               |
| 30  | Audit universe                     | `settings/audit-universe.astro`, `repos/auditUniverse.ts` | Yes                                               |
| 31  | Dropdowns                          | `settings/dropdowns.astro`, `api/dropdowns.ts`            | Yes                                               |
| 32  | General settings                   | `settings/general.astro`, `repos/orgConfig.ts`            | Yes                                               |
| 33  | Send queue list and counts         | `send-queue.astro`, `repos/sendQueue.ts`                  | Yes                                               |
| 34  | Send queue retry                   | `api/send-queue/retry.ts`                                 | Yes                                               |
| 35  | Send queue dead letter             | `repos/sendQueue.ts:106-125`                              | Yes                                               |
| 36  | In-app notifications               | `api/notifications.ts`, `repos/inApp.ts`                  | User-scoped (correct)                             |
| 37  | Evidence upload                    | `api/evidence/upload-url.ts`, `complete.ts`               | Yes                                               |
| 38  | Evidence download                  | `api/evidence/[attachmentId]/download.ts`                 | Yes, plus storage-key check                       |
| 39  | Evidence delete                    | `api/evidence/[attachmentId]/delete.ts`                   | Yes                                               |
| 40  | AI draft and validate              | `api/ai/draft.ts`, `validate.ts`                          | Yes                                               |
| 41  | AI analytics                       | `api/ai/analytics.ts`                                     | Yes                                               |
| 42  | Access control read                | `settings/access-control.astro`                           | **No, platform-wide by design (AC-01)**           |
| 43  | Access control save                | `api/access-control.ts`                                   | **No, platform-wide by design (AC-01)**           |
| 44  | AI provider config                 | `settings/ai.astro`, `api/ai/config.ts`                   | **No, `GLOBAL` sentinel (AC-02)**                 |
| 45  | Outlook connection                 | `settings/email.astro`, `api/admin/outlook/*`             | **No, `GLOBAL` sentinel (AC-02)**                 |
| 46  | Roles list                         | `repos/permissionsAdmin.listRoleCodes`                    | No, platform-wide reference data (read-only here) |
| 47  | Enum values and transitions        | `repos/enums.ts`, `workflow/transitions.ts`               | No, platform-wide reference data (read-only here) |
| 48  | Overdue maintenance                | `repos/overdue.ts`                                        | Platform-wide by design, not user-reachable       |
| 49  | Login attempts and lockout         | `repos/loginAttempts.ts`                                  | Platform-wide by design (email and IP)            |
| 50  | Platform view and instance switch  | `platform.astro`, `api/org/switch.ts`, `api/org/leave.ts` | Platform owner only, audited                      |

### B. The permission-resolution and caching path, in full

```
Request
  |
  v
src/middleware.ts:95   readGrcSessionCookie          -> signed session id + MFA state
  |
  v
src/middleware.ts:113  resolveSession                -> userId, roleCode, isPlatformOwner,
  |                    (repos/session.ts:74-126)        homeOrganizationId, mustChangePassword
  |                                                     (one SELECT joining users and organizations)
  v
src/middleware.ts:120-147  acting organisation
  |    non-owner  -> homeOrganizationId, no cookie read, instanceSelected = true
  |    owner      -> readActingOrg cookie -> resolveActingContext
  |                  (repos/orgContext.ts:53-83, validated against active organisations)
  |                  -> instance id, or null meaning no instance
  v
src/middleware.ts:153-156  matrix
  |    isPlatformOwner || roleCode === 'SUPER_ADMIN'
  |         -> fullMatrix()                (matrix.ts:131-138, no database read at all)
  |    otherwise
  |         -> getPermissionMatrix(db, roleCode)      (rbac.ts:22-38)
  |              |
  |              +-- matrixCache.get(roleCode)        (rbac.ts:19, module-level Map,
  |              |     hit  -> return, no query             per isolate, NO TTL)
  |              |     miss -> SELECT module_code, action_code, is_allowed
  |              |             FROM role_permissions WHERE role_code = ?
  |              |             -> buildMatrix -> matrixCache.set
  v
src/middleware.ts:157  deriveLegacyPerms(matrix)     (matrix.ts:167-169)
  |                    -> ['WORK_PAPERS.view', ...] for pre-matrix call sites
  v
src/middleware.ts:164+ locals.grc = { organizationId, matrix, perms, can, hasFeature, ... }
  |
  v
src/middleware.ts:178  must_change_password gate
src/middleware.ts:181  instance gate (owner with no instance -> /platform, or 409)
src/middleware.ts:188  pageAccess(matrix, pageSlugForPath(appPath))   (matrix.ts:110-114)
  |
  v
Route
  |    page   -> can(Astro.locals, action, module)    (rbac.ts:47-50)
  |    API    -> can(locals, action, module) or requirePermission (rbac.ts:57-64)
  |              both read locals.grc.matrix and apply the aliases (matrix.ts:30-31)
  v
Repository -> every statement binds locals.grc.organizationId
```

Invalidation, and where it stops:

```
Admin saves the matrix
  |
  v
api/access-control.ts:39-44   54 sequential setGrant calls (no transaction, no try/catch)
  |                            -> throws on the first CONFIG grant (section 2.3)
  |                            -> 42 grants already committed
  v
api/access-control.ts:45      invalidateRoleMatrix(roleCode)   <-- never reached on the throw
  |                            and even when reached, clears matrixCache in
  |                            THIS ISOLATE ONLY. Every other isolate keeps
  |                            the stale matrix until it is recycled.
  v
Other isolates                 stale, indefinitely
```

### C. Method

- Every SQL literal under `src/lib/grc/repos/**` and `src/pages/grc/api/**` was
  extracted, the tenant tables it touches identified, and the presence of an
  `organization_id` predicate checked; all 15 initial hits were then read by
  hand, of which 11 proved false positives from interpolated `WHERE` builders
  and 4 were confirmed correct by design (section 3.2).
- Every `can(...)`, `requirePermission(...)` and `isPlatformOwner` gate in
  `src/pages/grc` was enumerated (47 `can` call sites, 1 remaining literal role
  comparison).
- The middleware, `rbac.ts`, `matrix.ts`, `orgContext.ts`, `session.ts`,
  `permissionsAdmin.ts` and `GrcLayout.astro` were read in full.
- Findings recorded in the earlier `grc/docs/system-audit.md` were re-checked
  rather than carried forward. Three of them are now fixed and are **not**
  repeated here: the hard-coded SUPER_ADMIN checks on eleven Setup surfaces, the
  decorative and drifted `PAGE_PERMISSION_MAP`, and the unscoped work-paper list.
