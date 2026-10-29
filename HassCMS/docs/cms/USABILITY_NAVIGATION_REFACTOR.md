# CMS usability and navigation refactor

**Nothing was removed.** Every route, permission, filter, action and record
that existed before this work exists after it, at the same address, behind the
same check. What changed is where things sit, what they are called, and how
many equally weighted choices a person is asked to make at once.

The visual theme is untouched: no palette, font, radius, icon set or component
styling was changed.

## Principles applied

| Principle               | Where                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Recognition over recall | Page search: forty destinations findable by name or by a word for them, instead of memorised locations           |
| Hick–Hyman              | Administration 12 flat → 4 groups; Helpdesk 7 queues → 3 + a menu; user record 9 tabs → 6 sections               |
| Information scent       | `Data` → `Upload Centre`, `Performance` → `SLA Monitor`; `More views` and `CRM settings` rather than `More`      |
| Progressive disclosure  | Home's trend and leaderboard behind one control; Administration's Advanced group; CRM settings                   |
| Gestalt grouping        | Administration's four semantic groups; the user record's task-shaped sections                                    |
| Chunking                | Two-dimensional Orders navigation instead of four flat destinations                                              |
| Spatial consistency     | The same Orders control in the same place on all four order screens; the same CRM strip on all three CRM screens |
| Interruption recovery   | Every navigation state stays in the URL; only rail pin, Home disclosure and the first-use cue are browser-local  |
| Error prevention        | A KPI links to a queue only where the two count the same population                                              |
| Fitts' law              | Segmented controls and 44px-class targets on the new local navigations                                           |

## Before and after

### Main navigation

Eight rail destinations before and after, same routes, two labels improved.

| Before                                 | After             | Route                 |
| -------------------------------------- | ----------------- | --------------------- |
| Home, Customers, CRM, Helpdesk, Orders | unchanged         | unchanged             |
| **Performance**                        | **SLA Monitor**   | `/app/performance`    |
| **Data**                               | **Upload Centre** | `/app/data`           |
| Administration                         | unchanged         | `/app/administration` |

The rail is now _derived_ from a single destination catalogue
(`src/lib/cms/destinations.ts`) rather than written beside two other lists, so
the rail, the Administration page and page search cannot disagree.

### Global search

Record search is byte-for-byte unchanged: the same seven entity types, the same
scope predicate inside each query, the same ranking. A **Go to** group was
added alongside it — permission-filtered, ranked exact → prefix → keyword →
contains, and costing **no database query**, because destinations are static and
permissions are already resolved on the request. The placeholder now reads
`Search records or pages`.

### Administration

Twelve destinations, all preserved, in four groups:

- **People & access** — Users, Job titles, Organisation, Roles and permissions, Access review, Workflow authority review
- **Process & configuration** — Workflows, Product catalogue, Channels, AI
- **Assurance & system** — Audit trail, System health
- **Advanced** — Design reference (collapsed, last)

A group with nothing in it for the current reader is not rendered at all.

### User record

Nine primary tabs → six task-shaped sections, with the old nine as subsections:

| Section      | Holds                                                     |
| ------------ | --------------------------------------------------------- |
| Overview     | unchanged                                                 |
| Edit         | current-state edit, including the Position & Access panel |
| Organisation | Assignments · Teams                                       |
| Access       | Access roles · Workflow authority                         |
| Security     | Identity · Security                                       |
| History      | Audit                                                     |

**Every legacy `?tab=` value still works** — `?tab=assignments` opens
Organisation with Assignments revealed. No 404, and no silent fall-through to
Overview. The mapping lives in `src/lib/cms/admin/userSections.ts` and every
key is walked by a test.

Grouping roles and workflow authority under one heading did **not** merge them:
`ADMIN.ROLES.MANAGE` and `ADMIN.WORKFLOW_ROLES.MANAGE` remain independent, are
checked separately, and neither implies the other.

### CRM

Three operational tabs — Leads, Opportunities, Activities — on all three
screens, from one shared component. Configuration sits behind one permission-aware
**CRM settings** menu holding Lead sources, Pipelines, Lost reasons and CRM
analytics.

Three of those four had **no link anywhere in the product** and could only be
reached by typing the URL. This refactor is the first time they are navigable.

### Helpdesk

All seven queue keys preserved and still accepted from any URL. Primary strip:
**My cases · Unassigned · All**. Behind **More views**: New, Waiting customer,
Waiting internal, Resolved — and the summary shows the selected one by name,
opened, when a reader arrives on a bookmarked queue.

One KPI became clickable. Only one, deliberately:

| KPI            | Predicate                | Queue                              | Linked  |
| -------------- | ------------------------ | ---------------------------------- | ------- |
| New            | `status = 'NEW'`         | `new`, identical                   | **Yes** |
| Assigned to me | mine **and still open**  | `mine` is every case ever assigned | No      |
| In progress    | `status = 'IN_PROGRESS'` | no queue exists                    | No      |
| Waiting        | both waiting statuses    | no single queue                    | No      |
| Resolved today | `resolved_at` is today   | `resolved` is all resolved         | No      |

A figure that opens a list showing a different number is worse than a figure
that opens nothing.

### Home

The first view still answers "where is time being lost": headline figures,
approval breakdown by function, waiting signals, and the Needs attention table.
The month-over-month trend and the approver leaderboard moved behind one
**More detail** control per process, which remembers its state per browser in
`localStorage`. Every figure is still computed and still server-rendered.

### Orders

The hub is kept. All four workspaces gained the same two-dimensional local
navigation in the same position: **Sales orders | Purchase orders** and
**Operations | Performance**. Switching one dimension keeps the other, so a
reader compares sales and purchase turnaround without returning to the hub. The
process chooser is hidden when the reader may see only one process.

### Breadcrumbs

Eight CRM pages showed a clickable ancestor labelled **CRM** pointing at
`/app/crm` — a page whose heading reads **Leads**. That ancestor now says Leads,
which is what opening it produces. `/app/crm` itself read `Home / CRM / Leads`,
naming the same page twice with one false ancestor; it now reads `Home / Leads`.
The `Data` breadcrumbs follow the glossary.

## Functional preservation ledger

| Feature                   | Before                | After                            | Route                   | Permission | Functionality             |
| ------------------------- | --------------------- | -------------------------------- | ----------------------- | ---------- | ------------------------- |
| Users                     | Admin, flat list      | Admin → People & access          | preserved               | preserved  | preserved                 |
| Organisation              | Admin, flat list      | Admin → People & access          | preserved               | preserved  | preserved                 |
| Roles and permissions     | Admin, flat list      | Admin → People & access          | preserved               | preserved  | preserved                 |
| Access review             | Admin, flat list      | Admin → People & access          | preserved               | preserved  | preserved                 |
| Workflow authority review | Admin, flat list      | Admin → People & access          | preserved               | preserved  | preserved                 |
| Job titles                | Admin → Users only    | Admin → People & access + search | preserved               | preserved  | preserved                 |
| Workflows                 | Admin, flat list      | Admin → Process & configuration  | preserved               | preserved  | preserved                 |
| Product catalogue         | Admin, flat list      | Admin → Process & configuration  | preserved               | preserved  | preserved                 |
| Channels                  | Admin, flat list      | Admin → Process & configuration  | preserved               | preserved  | preserved                 |
| AI                        | Admin, flat list      | Admin → Process & configuration  | preserved               | preserved  | preserved                 |
| Audit trail               | Admin, flat list      | Admin → Assurance & system       | preserved               | preserved  | preserved                 |
| System health             | Admin, flat list      | Admin → Assurance & system       | preserved               | preserved  | preserved                 |
| Design reference          | Admin, flat list      | Admin → Advanced (collapsed)     | preserved               | preserved  | preserved                 |
| SLA rules                 | link from SLA Monitor | same, plus page search           | preserved               | preserved  | preserved                 |
| Lead sources              | small link on Leads   | CRM settings + page search       | preserved               | preserved  | preserved                 |
| Pipelines                 | **no link anywhere**  | CRM settings + page search       | preserved               | preserved  | **now reachable**         |
| Lost reasons              | **no link anywhere**  | CRM settings + page search       | preserved               | preserved  | **now reachable**         |
| CRM analytics             | **no link anywhere**  | CRM settings + page search       | preserved               | preserved  | **now reachable**         |
| Assignments               | user tab 3 of 9       | Organisation → Assignments       | preserved + legacy link | preserved  | preserved                 |
| Teams                     | user tab 4 of 9       | Organisation → Teams             | preserved + legacy link | preserved  | preserved                 |
| User roles                | user tab 5 of 9       | Access → Access roles            | preserved + legacy link | preserved  | preserved                 |
| Workflow authority        | user tab 6 of 9       | Access → Workflow authority      | preserved + legacy link | preserved  | preserved                 |
| Source identities         | user tab 7 of 9       | Security → Identity              | preserved + legacy link | preserved  | preserved                 |
| User security             | user tab 8 of 9       | Security → Security              | preserved + legacy link | preserved  | preserved                 |
| User audit                | user tab 9 of 9       | History                          | preserved + legacy link | preserved  | preserved                 |
| Helpdesk queue presets    | 7 equal buttons       | 3 primary + 4 under More views   | all keys preserved      | preserved  | preserved                 |
| Case categories           | link on Helpdesk      | same, plus page search           | preserved               | preserved  | preserved                 |
| Sales operations          | Orders hub            | hub + local nav on all four      | preserved               | preserved  | preserved                 |
| Sales performance         | Orders hub            | hub + local nav on all four      | preserved               | preserved  | preserved                 |
| Purchase operations       | Orders hub            | hub + local nav on all four      | preserved               | preserved  | preserved                 |
| Purchase performance      | Orders hub            | hub + local nav on all four      | preserved               | preserved  | preserved                 |
| Home trend                | always visible        | behind More detail               | preserved               | preserved  | preserved, still computed |
| Home leaderboard          | always visible        | behind More detail               | preserved               | preserved  | preserved, still computed |

## Decluttering rules adopted

1. **If the interface already shows the fact, do not write a paragraph
   explaining it.** Four paragraphs removed; one had its single non-obvious
   fact moved onto the card it defines, behind the existing info affordance.
2. **Non-critical microcopy: five words or fewer where practical.**
3. **Never shortened**: security warnings, destructive-action confirmations,
   validation errors, access-denied explanations. Clarity outranks brevity
   where safety is involved.
4. **A disclosure's label must predict its contents.** `More views`,
   `CRM settings`, `More detail`, `Advanced` — never a bare `More`.

## Accessibility

Native `details`/`summary`, `nav`, `a` and `button` throughout; no navigation
framework was added. `aria-current` on every navigation set, current state
never signalled by colour alone, visible focus preserved, no animated page
transitions, and reduced-motion support untouched.

## Source of truth

`src/lib/cms/destinations.ts` is the one catalogue. The rail is derived from
it, the Administration page renders its Administration slice in groups, and
page search filters it. Server-side access checks stay entirely separate: the
catalogue's permission field decides what a person is _offered_, and every page
and endpoint authorises for itself regardless.
