# CMS navigation glossary

**One preferred term per concept, for what a person reads.** This governs UI
copy: navigation labels, page titles, tab labels, breadcrumbs, empty states and
microcopy.

It does **not** govern file names, route paths, SQL identifiers, permission
codes or domain terminology in code. `/app/data` stays `/app/data` while its
label reads Upload Centre, because a path is a production contract and a label
is a sentence a person reads. Renaming routes for tidiness breaks bookmarks,
integrations and audit records to fix nothing.

## Why a glossary at all

Two words for one thing costs the reader a translation every time they meet
either. Someone who learns "Helpdesk" from the rail and then finds "Service" in
a breadcrumb has to work out whether those are the same place — and the honest
answer, that they are, is one they can only reach by clicking. That is recall
where the product could have offered recognition.

## The terms

| Preferred                 | Means                                                  | Not                                 |
| ------------------------- | ------------------------------------------------------ | ----------------------------------- |
| **Home**                  | The orientation dashboard at `/app`                    | Dashboard, Overview                 |
| **Customers**             | The customer master: accounts and their contacts       | Accounts, Clients                   |
| **CRM**                   | The module holding leads, opportunities and activities | Sales, Pipeline (as a module name)  |
| **Leads**                 | A record of early interest, and the CRM landing page   | Enquiries, Prospects                |
| **Opportunities**         | A qualified deal being worked                          | Deals                               |
| **Activities**            | Follow-ups and logged interactions                     | My Work, Tasks                      |
| **Helpdesk**              | The module holding customer service work               | Service, Support                    |
| **Cases**                 | The record inside Helpdesk                             | Tickets, Issues                     |
| **Orders**                | The module holding both order processes                | —                                   |
| **Sales orders**          | The customer-facing order process                      | SO (in UI copy)                     |
| **Purchase orders**       | The procurement process                                | PO (in UI copy)                     |
| **SLA Monitor**           | Service-level performance and breaches                 | Performance (as a nav label)        |
| **Upload Centre**         | Importing extracts, and what happened to them          | Data, Imports (as a nav label)      |
| **Administration**        | System configuration                                   | Settings, Setup                     |
| **Users**                 | People with accounts                                   | Staff, Members                      |
| **Roles and permissions** | Access roles and what they grant                       | Security, RBAC                      |
| **Access role**           | A named set of application permissions                 | Role (unqualified, where ambiguous) |
| **Workflow authority**    | What a person may approve in a process                 | Approval authority                  |
| **Workflows**             | Process definitions and their stages                   | Processes                           |
| **Audit trail**           | The append-only record of changes                      | Log, Activity log                   |
| **Job title**             | Organisational position. Grants nothing                | Role                                |

## Module and record are not a conflict

`Helpdesk` is the module and `Case` is the record. `CRM` is the module and
`Lead` is the record. Using both is correct and is not an inconsistency; using
`Service` in one place and `Helpdesk` in another is.

## What changed under this glossary

Three visible labels, no routes:

| Was         | Now           | Route                            |
| ----------- | ------------- | -------------------------------- |
| Data        | Upload Centre | `/app/data`, unchanged           |
| Performance | SLA Monitor   | `/app/performance`, unchanged    |
| My Work     | Activities    | `/app/crm/activities`, unchanged |

`My Work` was the clearest case: the CRM tab strip has always called that page
Activities and led to it under that name, so a person following the tab arrived
somewhere that announced itself as a different screen.

## Where a term is deliberately not global

Do not run a global replace. `Performance` is still the right word for
`Orders → Sales orders → Performance`, which is order turnaround and not the
SLA Monitor. `Data` is still the right word in `Show the numbers`, in a data
table caption, and in the phrase "no data this month". The glossary settles
what a **navigation label, page title or breadcrumb** says, not every
appearance of a word.
