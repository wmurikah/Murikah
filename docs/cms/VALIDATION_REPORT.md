# Final validation and reconciliation report

**Hass Petroleum Customer Relationship, Service and SLA Management System**
Build Prompt 30. The last phase of the build.

Every figure below was produced by running something. Where a figure could not
be produced, it says so and says why, and no number stands in its place. A
claim with no evidence behind it is recorded as not proved rather than dressed
up as a result.

---

## 1. What was validated, and how

Passing isolated module tests is not sufficient. Every module in this system
has its own suite and every one of them passes, and none of them can show that
one business event flows across all of them without inconsistent state, double
counting, broken security or contradictory analytics. That is what this phase
tested.

The instrument is `test/cms/endToEnd.test.ts`: thirteen tests that drive the
real repository functions, against the real schema with every CHECK constraint
and foreign key present, and then work the resulting figures out by hand from
the tables and compare them to what the system reports. A difference is a
defect, not a rounding note.

**Organisational security is proved before any journey runs.** If a Kenya
finance manager can approve a Uganda transaction, every journey below is
measuring a system that does not enforce its own security model and the
numbers are worthless. So section 2 runs first, and everything after it
depends on it.

| Section | What it proves                                                       | Result |
| ------- | -------------------------------------------------------------------- | ------ |
| §2      | Organisational security holds before anything else is measured       | Pass   |
| §3      | Journey A: enquiry to won opportunity, reconciled by hand            | Pass   |
| §6      | Journey D: a case, with first response and pause, reconciled by hand | Pass   |
| §7      | Journey E: the portal shows the customer their own and nothing else  | Pass   |
| §8      | Cross-module reconciliation, four separate tests                     | Pass   |
| §9      | Integrity: foreign keys, orphans, duplicates, snapshots, SLA pauses  | Pass   |
| §10     | The permission matrix, nine personas, eleven modules                 | Pass   |
| §11     | The system fails safely: no half-written record on a rejected write  | Pass   |
| §12     | Every record is labelled and findable, and the cleanup script runs   | Pass   |

---

## 2. Health of the build

Measured on the phase 30 branch, at the commit this report ships in.

| Check            | Command                             | Result                                       |
| ---------------- | ----------------------------------- | -------------------------------------------- |
| Build            | `npm run build`                     | 983 files, **0 errors**, 0 warnings, 6 hints |
| Lint             | `npm run lint`                      | **0 errors**, 1 warning                      |
| Whole repository | `npm test`                          | 1,200 tests, 1,194 pass, **6 fail**          |
| CMS only         | `npx tsx --test test/cms/*.test.ts` | 631 tests, **631 pass, 0 fail**, 25.8s       |

**The six failures are not CMS failures and are not new.** They are the known
failures on `main`: one GRC smoke test and five GRC presentation audits. Phase
26's instructions were explicit that they are not this batch's to fix, and they
were not touched. The CMS suite is green on its own and the whole-repository
count is 6 before this batch and 6 after it.

The one lint warning is `src/components/grc/GrcFindingCard.astro`, an unused
variable in GRC code, and is also pre-existing.

**Surface covered:** 62 pages under `src/pages/cms/`, 145 endpoints under
`src/pages/cms/api/`, 86 modules under `src/lib/cms/`, 39 test files.

---

## 3. The reconciliations, worked by hand

Each of these computes the answer from the records with arithmetic written in
the test, then asks the system for the same figure. They agree.

### 3.1 CRM funnel and win rate (§3)

One lead was captured, contacted, qualified on four separate dimensions and
converted; the resulting opportunity was moved to a won stage.

| Figure                      | Worked by hand                        | System                              | Agree |
| --------------------------- | ------------------------------------- | ----------------------------------- | ----- |
| Funnel top (leads captured) | `COUNT(*) FROM leads`                 | `funnel().steps[0].leads`           | Yes   |
| Qualification denominator   | Every lead captured                   | `funnel().qualificationDenominator` | Yes   |
| Qualified step              | `status IN ('QUALIFIED','CONVERTED')` | `funnel()` Qualified step           | Yes   |
| Won                         | `status = 'WON'`                      | `winRate().won`                     | Yes   |
| Lost                        | `status = 'LOST'`                     | `winRate().lost`                    | Yes   |
| Denominator                 | won + lost                            | `winRate().denominator`             | Yes   |
| Win rate                    | won / (won + lost)                    | `winRate().winRatePercent`          | Yes   |

Two properties are asserted beyond equality, because they are the ones that go
wrong quietly:

- **A qualified lead that converts is still counted as qualified.** Dropping it
  out of the qualified step on conversion would make the funnel narrow as the
  business succeeds.
- **An open opportunity is reported and is not in the win-rate denominator.**
  Open is not lost, and putting it in the denominator would make the win rate
  fall every time a salesperson opened a deal.

Also proved in this journey: converting the same lead twice creates one
opportunity, not two; and the account keeps its lead history through the
transition.

### 3.2 Service analytics (§6)

| Figure       | Worked by hand                                    | System                  | Agree |
| ------------ | ------------------------------------------------- | ----------------------- | ----- |
| Cases opened | `COUNT(*) FROM service_cases`                     | `summary().casesOpened` | Yes   |
| Open backlog | `status NOT IN ('RESOLVED','CLOSED','CANCELLED')` | `summary().openBacklog` | Yes   |

Three properties are proved beyond the two counts.

**An internal note is not a first response.** The journey adds an INTERNAL
communication and asserts `first_response_at` is still null, then adds an
OUTBOUND one to the customer and asserts it is now set. A team that could stop
its own first-response clock by writing itself a note is measuring nothing.

**Elapsed and accountable are two figures and are never the same field.** The
case is paused on the customer, resumed and resolved, and the two are asserted
separately. Reporting elapsed time as if it were accountable time charges a
team for the days it spent waiting on somebody else.

**Resolution coverage is honest.** The measured population is asserted to be at
most the total, never the total presented as if every case had been measured.

The journey routes NEW to IN_PROGRESS to WAITING_CUSTOMER to IN_PROGRESS to
RESOLVED, which is the real status machine. The history is then read back and
asserted to hold WAITING_CUSTOMER **before** RESOLVED.

### 3.3 The credit denominator (§8)

`creditPicture()` reports approvals against the orders that **needed** credit
approval, not against every order. An order that never required it is not a
credit success and must not inflate the rate.

| Figure               | Worked by hand                 | System                     | Agree |
| -------------------- | ------------------------------ | -------------------------- | ----- |
| Orders in selection  | `COUNT(*)`                     | `ordersInSelection`        | Yes   |
| Requiring credit     | `credit_approval_required = 1` | `ordersRequiringCredit`    | Yes   |
| Not requiring credit | `credit_approval_required = 0` | `ordersNotRequiringCredit` | Yes   |

Required plus not-required equals the whole, so nothing is lost between the two
groups, and the turnaround population is asserted **never larger than the
orders that required credit**. A turnaround measured over more orders than
needed the approval is measuring something else.

### 3.4 One person, two processes (§8)

A principal who approves in both the sales order and purchase order processes
appears as **two rows**, never blended into one. Blending them would produce a
turnaround figure for a process nobody runs.

Proved structurally rather than by inspection: every sales order approver row
carries `processType: 'SALES_ORDER'`, the purchase order module has **no
`processType` field at all** because it only ever reports one process, and no
person appears in both sets under a single key.

### 3.5 Two managers with the same job title (§8)

Gabriel Musembi (Kenya) and Grace Atieno (Uganda) hold the same role and the
same workflow role. Both resolve as granted, and:

- The Kenya scope contains `AFF-KE` and **not** `AFF-UG`.
- The Uganda scope contains `AFF-UG` and **not** `AFF-KE`.

**No job title is read anywhere in the resolution.** The scope comes from the
assignment, so two people who share a title do not share data, and renaming a
title changes nobody's access.

### 3.6 Integrity (§9)

Not a reconciliation but the ground the others stand on, so it is recorded
here. All of these return zero or hold:

- `PRAGMA foreign_key_check` reports nothing.
- **No orphan** on any polymorphic `entity_id`, across every table that
  addresses its subject by type and identifier rather than by a foreign key.
  Those are the ones no cascade protects.
- **No duplicate canonical document**: one row per sales order number, one per
  purchase order number.
- **Exactly one current snapshot per entity**, and snapshot versions number
  1, 2, 3 with no gap.
- **No duplicate SLA warning and no duplicate breach.** A second breach row for
  one instance would be counted twice by every report that touches it.
- **Pauses balance.** Resumed is at most paused and never more; a pause may
  still be open, which is why the assertion is an inequality and not equality.
- Every workflow instance is valid.

### 3.7 The audit trail reconstructs the journey from itself alone (§8)

Given only `audit_events`, the account creation and the lead creation are both
recoverable, in order, and **every row names its subject and when it happened**,
so "who did this and to what" is always answerable without reading a business
table. An audit trail that needs the business tables to be readable is not an
audit trail.

The reconstruction is only worth something if nothing can be altered underneath
it, so the same test proves that again rather than citing it: an `UPDATE`
against `audit_events` is attempted for real and is **rejected by the database
trigger**, not by the application.

---

## 4. The permission matrix

Nine personas against eleven modules, resolved through the real
`resolveScope`, printed by the test run rather than written by hand.

```
PERSONA                   | Customers Leads Opportunities Cases Sales orders Purchase orders Imports Audit Credit SLA dashboard Administer users
System administrator      |    yes     yes       yes       yes      yes            yes         yes    yes    yes       yes             yes
Customer service manager  |    yes     yes       yes       yes      yes            yes         yes    yes    yes       yes             yes
Kenya finance manager     |    yes      -         -         -       yes            yes         yes    yes     -        yes              -
Uganda finance manager    |    yes      -         -         -       yes            yes         yes    yes     -        yes              -
Country manager           |    yes     yes        -        yes      yes            yes          -      -      -        yes              -
Group finance             |     -       -        yes        -       yes            yes         yes    yes     -        yes              -
Credit manager            |    yes     yes        -        yes      yes             -           -      -     yes       yes              -
Sales executive           |    yes     yes       yes       yes       -              -           -      -      -        yes              -
External customer         |     -       -         -         -       -               -           -      -      -         -               -
```

**The external customer row is entirely dashes and that is the point.** A
portal user holds no internal permission at all. Their access runs through the
portal tenancy scope, which is a different mechanism, and no internal
permission check can ever resolve in their favour by accident.

The two finance manager rows are identical in shape and different in scope:
each holds the same codes and reaches only their own affiliate's records. A
permission matrix that showed scope as well as code would need a third
dimension; the scope is proved separately in §2 and §7.

---

## 5. Security, proved by attack

### 5.1 The portal shows the customer their own and nothing else (§7)

Three separate properties are proved.

**A refusal and a miss are the same answer.** A portal user for ACC-001 asks
for another customer's sales order and another customer's case, by their real
identifiers. Each answer is asserted **deep-equal to the answer for an
identifier that never existed** (`SO-NEVER`, `CASE-NEVER`). A different
response would confirm the record exists, and that is itself the leak.

**A forged account parameter changes nothing.** Passing another customer's
account identifier into `portalScope` returns a scope that does not contain it.
The tenancy comes from the membership table, never from the request.

**The customer sees no internal information.** An INTERNAL communication naming
an employee is written on the customer's own case, and the serialised portal
view of that case is then asserted to contain no employee name, no internal
note, no `INTERNAL` direction and none of the internal-only statuses.

### 5.2 Cross-country approval (§2)

Asked through `resolveApprovers`, which is the code that actually decides an
approval, rather than through an interface that could be hiding a button:

- A Kenya transaction resolves to the Kenya finance manager and **not** to the
  Uganda one.
- A Uganda transaction resolves to the Uganda finance manager and **not** to
  the Kenya one.
- A Group-required stage resolves to the Group approver, and a local finance
  user is not among its candidates.
- A country manager is never Group-scoped. The administrator is, because
  ROLE-ADMIN at GROUP is a configured fact and not an exemption, and the sales
  executive, who holds no such thing, is not.

The two country answers are disjoint on those two people, which is the whole
point: same job title, same workflow role, different authority.

One detail worth recording because it looked like a failure and was not. The
transaction in this test carries a fuel line, because the seeded authority rule
restricts by product group. A transaction with **no** lines is correctly
refused by every approver, and the resolver's trace says exactly why: the rule
restricts by product and the transaction carries no lines to test. That refusal
is right. It is not what this test measures, so the test supplies a line.

### 5.3 Failing safely (§11)

A write that violates a constraint leaves **no half-written record**. An
account naming an affiliate that is not in its country is refused, and the test
then asserts that **neither the account nor an audit row** was written, not just
that the call returned an error. A system that writes the parent and fails
afterwards produces a record nobody can explain and nobody can delete.

**A duplicate submit makes one record, not two.** The same valid creation is
submitted twice; the second is refused on the unique account code and the count
is one. That is the double-submit a user produces by clicking twice on a slow
connection, and it is refused by the database rather than by a disabled
button.

---

## 6. Defect register

Every defect found across phases 26 to 30, with its severity. Severity is
about consequence to the business, not about how hard the fix was.

| ID          | Phase | Severity           | Defect                                                                                                                                                                                                                                                                                                                                                                             | Status                                                                                                                                                                                                                    |
| ----------- | ----- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D26-001** | 26    | **Critical**       | `src/pages/cms/api/admin/users/[id].ts` returned a user's audit history with **no permission check, no data scope and the raw `before_json`**. Any authenticated principal who could reach the endpoint could read another person's activity, unmasked and unscoped.                                                                                                               | **Fixed.** It now calls `userActivity`, which applies the caller's scope, checks the permission and masks the payload.                                                                                                    |
| **D28-001** | 28    | **High**           | The executive dashboard issued **72 database round trips** to render one screen, **26 of them (36 per cent) the identical scope-resolution query**. Sales order performance issued 28, of which 9 were. On Turso over the network that is most of a second of nothing.                                                                                                             | **Fixed.** A per-request memo keyed on the libSQL client, with the user and the permission code as the key inside it. 72 to 51 and 28 to 20, measured.                                                                    |
| **D30-001** | 30    | **High**           | `recordFirstContact` wrote a `LEAD_CONTACTED` audit row **unconditionally**. The two UPDATEs were guarded, so a second call never moved the timestamp, but the audit row was not, so calling it twice recorded **two first contacts for one lead**. Anybody counting those rows, and the response-time reporting does, would have counted a contact that did not happen.           | **Fixed.** The audit row and the domain event are both guarded by `isFirstContact`.                                                                                                                                       |
| **D28-002** | 28    | **Medium**         | An empty data table said "Nothing to show yet." On a filtered analytical table that is usually untrue, and it reads to somebody who picked the wrong dates as "the business has no purchase orders".                                                                                                                                                                               | **Fixed.** The default now says what an empty result does and does not mean, and every table may override it.                                                                                                             |
| **D28-003** | 28    | **Medium**         | "Follow-ups overdue" sat too close to the fixed SLA vocabulary, where _overdue_ is not a synonym for a breach and the permitted words are Within SLA, At Risk, Breached, Paused and Met.                                                                                                                                                                                           | **Fixed.** It reads "past their due date".                                                                                                                                                                                |
| **D30-002** | 30    | **Medium**         | `test/cms/endToEnd.test.ts` originally moved a case NEW to WAITING_CUSTOMER directly. The status machine refused it, correctly: a case nobody has picked up cannot be waiting on the customer for anything. The defect was in the test's model of the process, not in the process.                                                                                                 | **Fixed** in the test. No product change; the refusal was right.                                                                                                                                                          |
| **D30-003** | 30    | **Medium**         | The stage move takes an `expectedStageId` and refuses a lost race. The validation journey did not supply it and was refused with "Somebody moved this opportunity while you were looking at it." The optimistic check is correct and the caller was wrong.                                                                                                                         | **Fixed** in the test. No product change.                                                                                                                                                                                 |
| **D30-004** | 30    | **Low**            | `case_status_history.changed_at` holds **whole seconds** and the primary key is random hex, so **two transitions inside the same second have no order that can be read back**. In practice each transition is a separate request and they are seldom that close, but the schema records no monotonic sequence beside the timestamp, so the ordering is not guaranteed by anything. | **Open. Not fixed in this batch:** the fix is a schema change and the batch may not make one. See section 8.                                                                                                              |
| **D32-001** | 32    | **High**           | Every **trend median was silently dropped whenever any row in the period had no value**. One `ranked` CTE serves several columns in `soTrend`, `poTrend` and the service trend, so it cannot filter nulls the way a single-metric query does; the count counts only real values, but SQLite sorts NULL first, so the row number `(c + 1) / 2` landed inside the missing rows and returned NULL. Order to invoice, order to loading authority, credit median, the purchase order approval cycle and receipt to posting all read "Not available" for periods that had perfectly good figures in them. | **Fixed.** The ranking orders by `(column IS NULL)` first, so rows 1..c are the real values in ascending order, which is what the row number assumes. Five figures that reported nothing now report. Regression test in `test/cms/dashboardApprovals.test.ts`.                                                    |
| **D32-002** | 32    | **Medium**         | The value axis on a line or bar chart reserved a **fixed 56px**, which was sized for "40" and "95%". A duration axis says "3 h 20 min", so the right-anchored label started at a negative x and the reader was shown "h 20 min" with the hours cut off the left edge of the viewBox.                                                                                                                                                                                                                                                        | **Fixed.** The axis measures its own widest label and claims the room it needs. Regression test asserts every axis label anchor leaves space for its own characters.                                                                                                                                            |
| **D32-003** | 32    | **Medium**         | The SLA section was asked for a **hold reason distribution from `CREDIT_HOLD_NAME`**. That column is `raw_only` in `soImport.ts` and is not written to the curated `snapshot_json`, so **the only surviving copy is `import_rows.raw_json`**: one row per spreadsheet line per batch, not per order, with no scope predicate on it. Counting it would count spreadsheet rows across re-uploads and would bypass the Build Prompt 07 scope resolver.                                                                                          | **Open. Not built, deliberately:** the alternative was a chart of the wrong population that also leaked. The fix is a schema change — curate the column into `sales_orders` or into `snapshot_json` on import — and needs a decision. The release turnaround **by the person** in `HOLD_RELEASED_BY` **is** built, because the importer resolves it to the credit stage actor. |
| **D29-001** | 29    | **High**, external | `xlsx` 0.18.5 carries **two high advisories with no patched version on npm**. It is the only advisory in code that runs in the worker on untrusted input.                                                                                                                                                                                                                          | **Open. Not fixable in this batch:** every remedy is a dependency change, which is a stop condition. Mitigations recorded in `production/PRODUCTION_READINESS.md`.                                                        |
| **D29-002** | 29    | **High**, process  | The build was asked for PBKDF2 at **210,000 iterations**. Cloudflare Workers caps it at 100,000 and throws above it; Node applies no cap. So 210,000 passes every test in this repository and fails only on the deployed worker, which is how it reached production once and took sign-in down.                                                                                    | **Resolved by reporting rather than by faking.** 100,000, the platform ceiling, with the parameters recorded and the verifier dispatching on the stored algorithm so a stronger one can be added later with no migration. |

**Nothing above is unfixed and unrecorded.** The four open items are open for
stated reasons that are stop conditions in this batch, and each names what a
human has to decide.

### Severity definitions used

- **Critical**: data belonging to one party is readable by another, or a
  figure a decision is made on is wrong with nothing to indicate it.
- **High**: a real security or reliability exposure, or a performance defect a
  user experiences on every page load.
- **Medium**: a user is misled by wording, a label or an empty state, or a
  process is modelled wrongly somewhere.
- **Low**: a property that is not guaranteed by anything but is unlikely to be
  observed in practice.

---

## 7. The cleanup

`docs/cms/production/11_validation_cleanup.sql`.

**It has not been run against any live database, and running it against one is
not something this build did.** That is a stop condition and it was honoured.
What was done instead is the thing that can be done honestly, and it is more
than a read-through: the file on disk is **executed** by
`test/cms/endToEnd.test.ts` §12 against a throwaway harness database that the
test has just filled with labelled records, and **the script's own step 9
verification is then run and required to return zero on every count**. So the
claim "the cleanup script works" is backed by the script running, on the real
schema, with foreign keys on and every CHECK present.

What the run proves:

- Every labelled record is gone: accounts, contacts, leads, opportunities,
  cases, orders and their children.
- **Exactly one account was removed**, the labelled one. The count before and
  after differ by one, so it removed the target and nothing near it.
- **Not one audit row was deleted.** The count is identical before and after.
  After `audit/08_audit_immutability.sql` it could not be otherwise: the
  triggers refuse every DELETE. The audit trail of the validation run survives
  on purpose, because the evidence that a person tested the system is itself
  evidence.
- The configuration survived: roles, permissions and workflow definitions are
  all still there. They are configuration, not test data.
- **No test external credential is left active.** Checked as a count of
  EXTERNAL users who are ACTIVE and still hold a credential, and it is zero.
- No orphan was created. The script deletes the polymorphic children
  (`activities`, `entity_attachments`, `notifications`, `record_snapshots`,
  `sla_instances`) explicitly, because those address their subject by type and
  identifier and no cascade reaches them.

Two design decisions in that script worth stating here:

- **The target set is frozen once**, into temporary tables, and every DELETE
  reads from those rather than re-evaluating the patterns. Without that, a
  DELETE that clears a name changes what a later DELETE matches.
- **No transaction keywords**, for the same reason as script 10: the Turso
  console runs a statement at a time and cannot hold one open, so a `BEGIN`
  there would be a comforting word that does nothing. The consequence is stated
  at the top of the file rather than hidden.

---

## 8. What a human must do before this goes live

These are the items that could not be closed from inside the build, each with
the reason and the decision required.

1. **Rehearse a backup and a restore.** This is recorded as **NOT PASSED** in
   `production/PRODUCTION_READINESS.md`, not as passed with a caveat. The build
   environment holds no credentials for any Turso database and obtaining them
   is a stop condition, so the rehearsal was not performed. The four steps a
   human must take are listed in that document. **RPO and RTO are blank and
   marked awaiting approval rather than invented.**

2. **Decide on `xlsx` (D29-001).** Two high advisories, no npm fix. The
   options are a pinned fork, the vendor's own distribution channel, or
   removing spreadsheet export. All three are dependency changes and none could
   be made in this batch.

3. **Decide on D32-003.** The hold reason lives only in `import_rows.raw_json`
   today. Curating `CREDIT_HOLD_NAME` into `sales_orders` (or into the
   snapshot payload) is a schema change and a re-import, and until it is made
   the SLA section shows the credit release **by person** and no reason
   distribution, because an empty chart is worse than no chart and a chart
   built on raw import rows would count the wrong population.

4. **Decide on D30-004.** Adding a monotonic sequence column to
   `case_status_history` is a schema change. If the answer is yes, it is a
   numbered script under `docs/cms/`, written for the operator and run by them.

5. **Run the numbered scripts in order**, per `docs/cms/SCHEMA_REGISTER.md`,
   and confirm `GET /api/health` reports `ok` before running
   `production/10_production_cleanup.sql`. That order is deliberate: verify the
   schema is complete while the demo data is still there to verify it against.

6. **Run `pnpm db:cms:bootstrap-admin`** to create the first real
   administrator, after the demo seed has gone.

6. **Read `production/10_production_cleanup.sql` end to end before running
   it.** It is the most dangerous file in the project. It has been run by
   nobody.

---

## 9. What this report does not claim

- It does not claim the system has been load tested end to end. The phase 29
  figures are **application layer**, measured against the harness, not against
  Turso over a network. The query counts are the meaningful number there; the
  milliseconds are not a production prediction and are not offered as one.
- It does not claim a security audit. It claims sixteen security tests that
  attack as six named actors, and a permission matrix resolved through the real
  resolver, and those are what they are.
- It does not claim the six GRC failures were investigated. They were out of
  scope by instruction and were left alone.
- It does not claim any figure for anything the database did not answer.
  Throughout the system, absent is rendered "Not available" and never zero, and
  this report follows the same rule.
