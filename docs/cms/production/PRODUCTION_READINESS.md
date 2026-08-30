# CMS production readiness

Phase 29. **Evidence, not assertion.** Every claim below is produced by a
command, an output or a measurement, and where something could not be proved
from this environment it says so instead of claiming it.

## 1. Threat model

### Assets, the control that protects each, and the test that proves it

| Asset                                     | Control                                                                    | Proved by                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Customer and contact data                 | BP07 scope resolver, applied in the `WHERE` of every read                  | `security.test.ts`: a Kenya user cannot read a Uganda account by identifier           |
| Leads and opportunities                   | The same, through `scopedLeads` and `scopedOpportunities`                  | `security.test.ts` IDOR block                                                         |
| Order data and credit information         | Order scope plus `CREDIT.EXCEPTION.APPROVE` for the credit columns         | `searchReports.test.ts`: the credit column is **absent**, not empty, without the code |
| Service cases and internal communications | Case scope; `direction <> 'INTERNAL'` excluded in SQL for the portal       | `portal.test.ts`: an internal note is absent from the serialised body                 |
| Approval authority                        | Effective-dated `workflow_role_assignments` and `approval_authority_rules` | `workflow.test.ts`; `controlCentre.test.ts` authority review                          |
| Sessions                                  | HMAC-hashed cookie, server-side session row, resolved per request          | `security.test.ts`: a suspended user loses access on the next request                 |
| The audit trail                           | Two database triggers refusing UPDATE and DELETE                           | `controlCentre.test.ts`: both refusals, with their error text                         |
| Uploaded files                            | Content sniffing, size ceiling, safe filename, hash recorded               | `uploadCentre.test.ts`                                                                |
| Portal documents                          | `customer_visible` defaulting to 0, re-checked on download                 | `portal.test.ts`: a hidden and a foreign document both refused                        |

### Actors, and what stops each

| Actor                                    | What they try                           | What stops them                                                                                                                                          |
| ---------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unauthenticated attacker**             | Reach any page or endpoint              | Default-deny middleware: the public list has three entries and a page added later is protected because nobody had to remember to protect it              |
| **Compromised internal account**         | Read beyond their scope                 | The scope is in the query, not the interface. Frontend hiding proves nothing and is not relied on                                                        |
| **Over-privileged internal user**        | Approve outside their authority         | Approval authority is separate from application access, effective-dated, and reviewed on its own screen                                                  |
| **Curious or malicious portal customer** | Reach another customer's records        | `portalScope` reads memberships from the database, never the request; a forged `accountId` is ignored; every refusal is identical to a miss              |
| **Compromised uploader**                 | Put a malicious file through the import | Content sniffed by magic bytes, not by the declared type; 8 MB ceiling; filename cannot traverse; formula prefixes neutralised; SheetJS executes nothing |
| **Automated credential attacker**        | Guess a password                        | Rate limit before the credential check, lockout, one generic failure message, PBKDF2 at the platform maximum                                             |

## 2. Authentication

**Password hashing. The phase asked for at least 210,000 PBKDF2 iterations. That is impossible on this platform and the requirement cannot be met.**

```
NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
supported (requested 210000)
```

Cloudflare Workers caps PBKDF2 at 100,000. Node applies no such cap, so 210,000
passes every test in this repository and fails only on the deployed worker,
which is exactly how it reached production once and took sign-in down. The fix
is commit `19313ed` on `main`, "fix(cms): cap PBKDF2 at the 100,000 iterations
Workers allows".

Recorded parameters, all asserted in `security.test.ts`:

| Parameter     | Value                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| Algorithm     | PBKDF2-HMAC-SHA-256 via WebCrypto                                                          |
| Iterations    | **100,000**, the platform ceiling                                                          |
| Salt          | 16 random bytes, per credential, from `crypto.getRandomValues`                             |
| Derived key   | 256 bits                                                                                   |
| Stored format | `pbkdf2-sha256$<iterations>$<salt>$<key>`, self-describing                                 |
| Comparison    | `timingSafeEqual`, constant time, length-checked first                                     |
| Dispatch      | On `auth_credentials.password_algorithm`, so Argon2id can be added later with no migration |

**Why not Argon2id.** Recorded in Build Prompt 03 and unchanged: Argon2 needs a
native or WASM package the Workers runtime cannot provide. The schema permits
`PBKDF2` explicitly, the verifier dispatches on the stored algorithm, and a
credential written under another algorithm fails closed with
`unsupported_algorithm` rather than being silently accepted.

**Sessions.** A suspended user loses access **on their next request**, not at
the next session expiry: the identity is resolved from the database on every
request and the query requires `status = 'ACTIVE'`. Asserted directly.

## 3. Authorisation

Every scope type asserted by direct call, not by checking the interface:
`OWN`, `TEAM`, `BUSINESS_UNIT`, `AFFILIATE`, `COUNTRY`, `GROUP`.

**IDOR: possessing an identifier is never authorisation.** The sales executive,
who holds five permission codes and none of them for orders or audit, is given
real identifiers for a sales order, a purchase order and an audit event, and
gets `null` for each. The credit manager, who _does_ hold
`ORDERS.SALES_ORDER.VIEW`, reads the same order: the refusal is a missing
permission, not a wall.

**Portal tenant isolation, the highest-severity area.** Six attempts by customer
A against customer B's account, order, case, attachment, survey and contact.
Every one returns `null`, and every one is **deep-equal to the answer for an
identifier that never existed**, so the refusal does not confirm the record is
real. A forged `accountId` parameter is ignored. An internal employee gets no
portal scope at all.

## 4. Input, files, secrets, logging, errors

- **Parameterised SQL everywhere.** Every `${}` inside a `sql:` template is
  examined individually: 0 interpolate a request value. The one apparent
  exception, `${ORDER_BY[input.sort]}`, is a lookup into a frozen map keyed by
  a union type, where every value is a literal column expression and a miss
  yields `undefined` rather than attacker-controlled SQL.
- **Formula injection** defused in CSV and XLSX, in the data and the metadata,
  for `=`, `+`, `-`, `@`, tab and carriage return.
- **Secrets**: no token, key or private-key block anywhere in `src/`. The CMS
  reads `TURSO_CMS_DATABASE_URL`, `TURSO_CMS_AUTH_TOKEN` and
  `CMS_SESSION_SECRET` and **never** the marketing site's `TURSO_DATABASE_URL`
  or `TURSO_AUTH_TOKEN`, which point at a different database. Asserted across
  every CMS source file.
- **Logging**: no `console.*` call anywhere in the CMS carries a password,
  session token, MFA secret, reset token or a bare request body. A derived
  address string via `clientIp(request)` is what a log should carry and is
  exempt by name.
- **Errors**: an unexpected throw becomes `server_error`, "That could not be
  completed.", a 500 and a trace identifier. The message and the stack go to
  the log. The response carries neither.
- **No backdoor account, no default password.** Asserted across every CMS
  source file, and `rbac.ts` names no specific user id and no specific email.

## 5. Headers, CSRF, rate limits, dependencies

**Headers are set in the CMS branch of `src/middleware.ts`, on CMS responses
only.** `wrangler.jsonc` and `src/worker.ts` are byte-identical to `main`.

```
content-security-policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  connect-src 'self'; form-action 'self'; frame-ancestors 'none';
  base-uri 'self'; object-src 'none'; upgrade-insecure-requests
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
permissions-policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(),
  magnetometer=(), microphone=(), payment=(), usb=()
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
strict-transport-security: max-age=63072000; includeSubDomains   (https only)
```

`script-src 'self'` with no `unsafe-inline` and no `unsafe-eval` is the
directive that matters. The two relaxations are named and reasoned in the
module: `style-src 'unsafe-inline'` for component styles and server-rendered
SVG, `img-src data:` for inline icons and the favicon.

**CSRF.** SameSite=Lax is not relied on alone. A mutating request must declare
an Origin or a Referer and it must be this host; a request with **neither** is
refused, because defaulting to allow would make the check optional for anybody
able to omit a header. An origin check rather than a signed token: it refuses
the same attack without a token mint, a rotation story, a hidden field on every
form and a failure mode where a stale tab cannot submit. All four mutating
verbs are covered; `GET` and `HEAD` are never blocked.

**Rate limits**, all through the existing helper, no package added:

| Surface              | Limit | Window    |
| -------------------- | ----- | --------- |
| Sign-in              | 20    | 5 minutes |
| Portal case creation | 10    | 1 hour    |
| Portal reply         | 40    | 1 hour    |
| Portal survey        | 20    | 1 hour    |
| Workbook upload      | 30    | 1 hour    |

Keyed on the user and the address together: two colleagues at one customer
share an office address, and limiting by address alone would let one exhaust
the other's allowance.

## 6. Schema change control, seed data, backup

- **The register** is `docs/cms/SCHEMA_REGISTER.md`: eleven scripts, their
  order, what each does, whether it is re-runnable, whether it is reversible
  and how to verify it applied. Every script carries its own verification
  query, and `GET /api/health` runs four of those checks live, so the answer
  comes from the database rather than from a record of intent.
- **Not trivially reversible**: the baseline, the SO/PO source completeness
  rebuild, script 07's `ADD COLUMN`s, and script 08's triggers. Each is named
  in the register with the reason.
- **The production cleanup script** is `docs/cms/production/10_production_cleanup.sql`.
  **It has not been run by anybody.** It carries a four-condition warning
  block, looks before it deletes, deletes no audit row, suspends the demo
  users rather than deleting them (so their audit rows keep a subject, and
  because script 08's triggers refuse the `ON DELETE SET NULL` cascade a delete
  would attempt), and verifies afterwards.

### Backup and restore: **THIS GATE HAS NOT PASSED**

The phase requires a real restore into a non-production database, verified
across eight object types, with a sign-in against the restored copy. **That
was not done and could not be**: this build environment has no credentials for
any Turso database, and obtaining them is a stop condition for this batch.

Saying the capability exists because a document describes one is exactly what
the phase forbids, so this is recorded as **not passed** rather than dressed
up. What a human must do:

1. Record what the Turso plan actually provides: point-in-time recovery
   window, snapshot frequency, retention, and who owns the account.
2. Restore into a non-production database and verify **users, roles,
   customers, orders, workflows, audit rows, snapshots and attachment
   metadata**, then sign in against the copy.
3. Record the duration, the issues and the consistency result.
4. Test the two consistency failures: a restored database whose attachment is
   missing, and an attachment whose database row is missing. Neither has a
   detection routine today; `/api/health` is the natural place for one.

**RPO and RTO are deliberately blank.** Inventing business-approved targets
would be inventing a number.

| Field                    | Value | Status                           |
| ------------------------ | ----- | -------------------------------- |
| Recovery point objective |       | **Awaiting management approval** |
| Recovery time objective  |       | **Awaiting management approval** |
| Backup owner             |       | **Awaiting management approval** |
| Restore rehearsal date   |       | **Not yet performed**            |

## 7. Health, observability, load, timeouts, privacy, break-glass

**Health.** `GET /api/health`, unauthenticated by necessity (a check that needs
a session cannot tell you the database is down). It reports three states and
the four prerequisite scripts, and **nothing else**: no version, no hostname,
no table name, no row count, no error text. A failure logs the cause with a
trace id and returns the id. 503 when the database is unreachable so an uptime
monitor sees a failure.

**Load figures**, from `test/cms/load.test.ts`, using the real extracts:

| Scenario                                       | Median   | P90     | Detail            |
| ---------------------------------------------- | -------- | ------- | ----------------- |
| SO import: validate the real 1,386-row extract | 781.9 ms | —       | 1,386 rows staged |
| SO import: commit                              | 173.8 ms | —       |                   |
| PO import: validate the real 45-row extract    | 40.1 ms  | —       |                   |
| PO import: commit                              | 43.6 ms  | —       |                   |
| Large sales order list, page 1                 | 0.8 ms   | 1.0 ms  |                   |
| Sales order summary                            | 6.4 ms   | 7.0 ms  |                   |
| Executive dashboard                            | 17.7 ms  | 19.4 ms | all four modules  |
| Large audit history, unbounded window          | 10.6 ms  | 14.7 ms |                   |
| Global search, seven groups                    | 1.7 ms   | 1.9 ms  |                   |
| 20 concurrent internal dashboards              | 326.3 ms | —       | total wall clock  |
| 20 concurrent portal home pages                | 16.9 ms  | —       | total wall clock  |

**What these figures are and are not.** They are application-layer measurements
against a synchronous in-process database. They are **not** an end-to-end HTTP
measurement against the deployed worker, which would need `wrangler dev`
pointed at a real Turso database and therefore credentials this environment
does not have.

**So the query counts matter more than the milliseconds.** Production adds one
network round trip per query. At roughly 30 ms to Turso, a view issuing 51
queries cannot be faster than about 1.5 seconds however fast its SQL is. Phase
28 measured and halved the worst of these; the current counts are in that
phase's report.

**Where it degrades.** The import is the only path whose cost grows with the
data: 1,386 rows takes 782 ms to validate in-process, and the commit writes in
200-statement chunks with each document in its own transaction, so a network
round trip per chunk is the real constraint. An extract several times larger
would need the chunking revisited, and the honest ceiling today is unmeasured
because no larger extract exists.

**Timeouts and retries.** No non-idempotent write is retried. Uploads are
idempotent by file hash: the same bytes under a different filename are refused
and write nothing. Import commits are idempotent by document: a re-commit
creates no duplicate order, no duplicate workflow event and no change to any
analytic count. Both are asserted in `uploadCentre.test.ts`.

**Break-glass.** There is none, and none is embedded. `pnpm db:cms:bootstrap-admin`
creates the first administrator on an empty database and is the only path in;
it is a command an operator runs with database credentials, not an account
that exists. No backdoor and no default password, asserted by grep.

## 8. Deployment, rollback, go-live gates

### Deployment checklist

1. **Environment**: the Cloudflare Worker exists and `cms.murikah.com` routes to it.
2. **Secrets**: `TURSO_CMS_DATABASE_URL`, `TURSO_CMS_AUTH_TOKEN`, `CMS_SESSION_SECRET` set as Cloudflare secrets, never in the repository.
3. **Schema scripts**: the register, in order, then `GET /api/health` returns `ok`.
4. **Bootstrap administrator**: `pnpm db:cms:bootstrap-admin`.
5. **Mail**: verify the invitation and reset delivery path, or accept that invitations must be delivered by hand.
6. **Storage**: attachments have no upload path yet; nothing to configure.
7. **Domain and TLS**: Cloudflare-managed. Confirm HSTS is being sent.
8. **Health**: `GET /api/health` returns `ok`, not `degraded`.
9. **Tests**: `pnpm build`, `pnpm lint`, `pnpm test` clean but the six known GRC failures.
10. **Backup**: **the rehearsal above, which has not been done.**
11. **Monitoring**: error rate, API latency, database latency, failed sign-in spikes, failed imports, SLA processor failures. Keep system telemetry separate from customer analytics.

### Rollback

**Do not assume a schema rollback is safe.** Prefer a forward fix for anything
touching data, plus a tested deployment recovery.

- **Code**: `wrangler rollback` to the previous worker version. Safe and fast.
- **Schema**: scripts 01 to 06 and 09 are data-only and reversible by deleting
  the rows. **Script 07 and the SO/PO rebuild are not** (SQLite cannot drop a
  column without rebuilding the table). **Script 08 is not, in practice**:
  dropping the audit triggers is one statement and is also removing the control
  that makes the trail evidence.
- **Data**: forward fix only. There is no undo for the cleanup script.

### Go-live gates

| Gate                              | Evidence                                                                   | Status                                   |
| --------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| Authentication                    | `security.test.ts`: parameters recorded, suspension effective next request | **PASS**                                 |
| RBAC                              | Every scope type by direct call; IDOR refusals                             | **PASS**                                 |
| Portal isolation                  | Six attempts, six refusals identical to a miss                             | **PASS**                                 |
| Approval authority                | Effective-dated; a Kenya approver does not staff a Uganda stage            | **PASS**                                 |
| Import reconciliation             | Real extracts; hash duplicate refused; per-document isolation              | **PASS**                                 |
| SLA calculation                   | Business calendar, pause, breach rows by UNIQUE                            | **PASS**                                 |
| Security headers and CSRF         | Header dump; cross-origin POST refused                                     | **PASS**                                 |
| Secrets                           | No literal in the repository; CMS reads only its own three                 | **PASS**                                 |
| Backup and restore                | —                                                                          | **NOT PASSED. Rehearsal not performed.** |
| Critical vulnerabilities resolved | `pnpm audit`: 0 critical, 20 high, see below                               | **CONDITIONAL**                          |
| Acceptance sign-off               | —                                                                          | **Awaiting phase 30 and a human**        |

## 9. `pnpm audit`

**31 advisories: 0 critical, 20 high, 10 moderate, 1 low.** Complete output in
the pull request. What matters:

| Package                                                                                                   | Severity                               | Ships in the worker?                  | Action                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`xlsx` 0.18.5**                                                                                         | **2 high**: prototype pollution, ReDoS | **Yes**                               | **No patched version exists on npm.** Patched builds are published only on SheetJS's own CDN. This is the one runtime-reachable finding and it needs a decision. |
| `astro`                                                                                                   | 3 moderate, 1 low: XSS variants        | Yes                                   | Fixed in 7.0.6 / 7.1.0. **Upgrading is a dependency change this batch may not make.**                                                                            |
| `undici`                                                                                                  | 1 high, 4 moderate                     | No: Node's fetch, build and test only | Transitive; resolves with a toolchain bump                                                                                                                       |
| `brace-expansion`, `js-yaml`, `yaml`, `postcss`, `svgo`, `nanoid`, `fast-uri`, `fast-xml-parser`, `sharp` | 14 high/moderate                       | No: build-time only                   | Transitive; resolves with a toolchain bump                                                                                                                       |

**The `xlsx` finding is the one to act on.** It is the only advisory in code
that runs inside the worker on untrusted input, and untrusted input is exactly
what it gets: an uploaded workbook. Mitigations already in place, none of which
make the advisories go away:

- The upload is authenticated and needs two permission codes.
- Content is sniffed by magic bytes before the parser sees it.
- An 8 MB ceiling.
- Only cell values are read; no formula is evaluated and no macro can run.

**Neither the `xlsx` nor the `astro` fix can be applied in this batch**, because
both are dependency changes and section 0 approves none. Both are recorded here
as required actions.
