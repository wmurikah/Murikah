# Engineering navigation and database performance rollout

This change reuses one Turso client per authenticated request, batches the session and permission reads, and lets the notification bell load after the page. Migration `007` adds four indexes for the notification queue, unread badge, recent requests, and maintenance dates. It changes no workflow or records. The existing entity tables, link tables, foreign keys, and uniqueness rules remain the canonical relational model. The separate integrity audit checks real data for broken links and identity inconsistencies instead of rewriting production tables.

## Apply migration 007

First back up the Engineering Turso database. If you can run the repository command with the Engineering Turso URL and token, run `pnpm db:apply` from `Engr`. It applies the migration and history row atomically and verifies the schema contract.

If you only use Turso Web, run these statements in the Engineering database after the code is merged. Run them once in order; each `CREATE INDEX IF NOT EXISTS` is safe to retry. The final history row records the exact checksum of migration `007` in this version of the repository.

```sql
CREATE INDEX IF NOT EXISTS ix_notifications_queue_created
  ON notifications(created_at) WHERE status = 'QUEUED';

CREATE INDEX IF NOT EXISTS ix_notifications_unread
  ON notifications(org_id, channel, status, recipient_user_id);

CREATE INDEX IF NOT EXISTS ix_requests_org_created_active
  ON service_requests(org_id, created_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_pm_occ_org_due
  ON pm_occurrences(org_id, due_date);

INSERT OR IGNORE INTO schema_migrations (id, description, checksum)
VALUES ('007', 'Index notification delivery and organisation dashboard queries',
        'b2ccf1719a8d3f7ce9ed9d5e3eda1bc9ad910d4744703bd4713ec544e6363033');

SELECT id, checksum FROM schema_migrations WHERE id = '007';
```

The returned checksum must match the value above. If it differs, stop and inspect the migration history instead of replacing it. Then deploy a new Worker build from the merged commit; rebuilding an older commit will not include this code.

## Check integrity and measure

With the Engineering Turso URL and token available locally, run `pnpm db:integrity:check` from `Engr`. It is read only and prints counts for foreign-key violations, duplicate canonical emails, emails not stored lowercase/trimmed, and selected cross-organisation links. All counts should be zero. Do not auto-delete or rewrite records to clear a nonzero result; investigate each one.

After deployment, open Chrome DevTools → Network, load `/`, `/requests`, and an Admin list, then inspect the `Server-Timing` response header. `engr-db` is client setup, `engr-auth` is the live account/permissions check, and `engr-page` is the route and rendering. Compare several loads over the same connection before and after deployment. Keep the live permission check; do not cache account status or grants across users or requests. If `engr-page` remains high, profile the page-specific queries next. Redis is not needed for this first change and would introduce another network dependency.
