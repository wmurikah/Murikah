# SLA writes against the observed database schema

The 2 November 2026 hass-cms export is the contract for breach and escalation
writes. Deploy the CMS code after merge; no new database migration is needed
on that schema, and no entity/target columns are added to `sla_breaches`.

## Breach records

A breach stores its SLA instance, true breach time, measured breach minutes,
accountable user/team and workflow-stage attribution. Entity identity and the
original target remain on `sla_instances`, available through the instance
foreign key. The writer targets only the UNIQUE `sla_instance_id` conflict;
other integrity failures are not silently ignored.

Both sweep and overdue completion write against this shape. Completion before
any sweep also records a BREACH timer fact, so notification processing can
observe the breach. The SLA stop/transition, its breach timer fact and breach
row use a write batch. Existing sweep facts are reused, preserving one primary
breach and one BREACH timer event under repeated processing. Deadline/calendar
rules are unchanged by this schema repair.

## Escalation records

The exported escalation table requires `triggered_at` and a non-null lifecycle
`status`. Its `notification_id` is an immediate foreign key. The writer therefore
creates the notification first and its escalation event second in a single
write batch. If either insert fails, neither row survives, and a later sweep
can retry. Repeated processing skips the notification when the instance/level
already has an escalation, and the event conflict target is that exact unique
instance/level key.

A committed in-app escalation is recorded as `SENT`: its linked notification
is available to the recipient. This does not claim email or WhatsApp delivery.
The existing local-supervisor-before-Group selection and explanation metadata
remain intact. Finished work still records its breach and notification, but
is not newly escalated as work that remains open.

Existing breach/escalation rows are preserved. This code change does not
backfill historical missing facts or change previously recorded escalation
statuses. It does not add a scheduled worker or change notification frequency.

## Validation

The shared test fixture's two table definitions now come from the export,
including the notification foreign key and required status. Tests cover real
case completion, direct overdue completion before a sweep, repeat processing,
local escalation, foreign-key integrity and rollback/retry for failed breach,
notification and escalation writes. Analytics attribution still reads the
stored accountable actor rather than attributing a breach to the closer.
