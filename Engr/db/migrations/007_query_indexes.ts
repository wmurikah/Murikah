import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

/** Index the predicates used on every authenticated visit and dashboard load.
 * All indexes are additive; the canonical relational tables stay unchanged. */
export const queryIndexes: Migration = {
  id: '007',
  description: 'Index notification delivery and organisation dashboard queries',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_notifications_queue_created
      ON notifications(created_at) WHERE status = 'QUEUED'`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_notifications_unread
      ON notifications(org_id, channel, status, recipient_user_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_requests_org_created_active
      ON service_requests(org_id, created_at) WHERE deleted_at IS NULL`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_pm_occ_org_due
      ON pm_occurrences(org_id, due_date)`);
  },
};
