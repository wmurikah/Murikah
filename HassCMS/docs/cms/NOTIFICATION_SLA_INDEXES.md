# Notification and SLA read indexes

## Selected indexes

`db/migrations/004_notification_sla_indexes.sql` adds five non-unique indexes:

| Index                                                                         | Predicate it supports                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `idx_notifications_user_unread(user_id, read_at)`                             | Unread count, unread filtering and mark-all-read selection   |
| `idx_notifications_dedup(user_id, notification_type, entity_type, entity_id)` | Notification existence guard, including nullable entity keys |
| `idx_sla_instances_due(status, target_at)`                                    | RUNNING instances whose target is due                        |
| `idx_sla_instances_warning(status, warning_at)`                               | RUNNING instances whose warning is due                       |
| `idx_sla_timer_instance_event(sla_instance_id, event_type)`                   | Correlated warning/breach event checks                       |

These target the existing query predicates. No notification frequency, SLA
calendar/deadline, authorisation, retention or scheduler behaviour changes.
The migration adds no uniqueness rules or application columns and removes no
existing index. Notification list sorting is a separate workload: these indexes
do not promise to eliminate its `ORDER BY created_at DESC, notification_id`
sort. No extra list-ordering index is included without workload evidence.

## Evidence and limitations

The operator's 2 November export lacks these secondary indexes. The historical
unit fixture already included some helper indexes; the new regression removes
those on the three relevant tables and restores the exported entity index
before testing, so it cannot accidentally measure an already-optimised fixture.

The test captures SQL from the actual unread-count, notification writer and SLA
sweep functions. With an additional 30,000 synthetic notifications, 3,000 SLA
instances and 12,000 timer events, it proves these plan changes:

- Notification count and deduplication: table scans become covering lookups.
- Due SLA selection: a table scan becomes a status/target range lookup.
- Warning selection: a table scan plus correlated event-table scan becomes a
  status/warning lookup plus a covering instance/event lookup.

Result sets, application row counts, deduplication and foreign-key integrity
are checked. The migration was also applied twice to a local reconstruction of
all 158 exported objects; the five indexes verified and every original schema
object remained unchanged.

These are local SQLite results, not live Turso timing, row-read or billing
measurements. Live row counts, write rates, storage size, plans and the current
index inventory were not accessible from this chat. Index maintenance consumes
write/storage work; measure that tradeoff rather than promising a bill reduction
from a plan alone. The diagnostic does not infer write rates from creation
counts, which would miss updates and other writes.

## Apply and verify

1. Run `db/diagnostics/notification_sla_index_review.sql` manually in hass-cms.
   Save the index inventory and plans. The three exact row counts scan their
   tables once; omit that block if row-read budget is tight. EXPLAIN compiles
   without returning customer records. Do not poll these diagnostics.
2. Inspect the existing key definitions. If an equivalent index already exists
   under another name, omit its duplicate CREATE from the migration. If a
   proposed name already describes another definition, resolve that explicitly;
   `IF NOT EXISTS` never replaces it. Index construction can consume database
   resources on a large table, so use the observed size/write activity to choose
   a suitable application time.
3. Apply `db/migrations/004_notification_sla_indexes.sql` in the Turso SQL console.
   It has no dependencies on migrations 001/002/003, rebuilds no tables and is
   rerunnable. All five verification rows should be `OK` for the proposed names;
   a mismatch must be inspected. The verifier checks table, ordered key columns,
   collation, direction, uniqueness and partial-index status. If an equivalent
   differently named index was deliberately retained, document that selection
   instead of creating a duplicate merely to get the expected name.
4. Run only the inventory/EXPLAIN portions again. Confirm that production plans
   use index searches for these predicates. The tests run ANALYZE on their
   synthetic data; the production migration deliberately does not force a
   full statistics rebuild. If the live planner differs, inspect live statistics
   and selectivity before changing or removing further indexes.
5. Compare Turso-reported row reads, row writes and storage plus CMS
   Server-Timing/slow-request logs over comparable activity windows. Include
   unread-count and SLA-driven pages; an idle day versus an upload-heavy day
   is not a fair performance comparison.

This is a database-only rollout: merging a PR or deploying CMS does not execute
this SQL. Once the indexes are applied, existing application queries can use
them without a CMS deployment. No production action has been performed by the
agent, and the application does not create indexes at request time.
