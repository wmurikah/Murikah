import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

/**
 * An affiliate is a classification within a parent tenant, not a separate
 * change of the owning org_id for a station or its operational history.
 *
 * Keep all station, region, asset, request and user identifiers unchanged.
 * Existing station affiliations inherit from their region, else their owner.
 */
export const stationAffiliateWithinTenant: Migration = {
  id: '011',
  description: 'Stations classified by affiliate inside their existing tenant',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    const columns = await db.execute('PRAGMA table_info(stations)');
    if (!columns.rows.some((r) => String(r.name) === 'affiliate_org_id')) {
      await db.execute(
        'ALTER TABLE stations ADD COLUMN affiliate_org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL',
      );
    }
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_stations_affiliate
      ON stations(org_id, affiliate_org_id, region_id)`);
    await db.execute(`UPDATE stations
      SET affiliate_org_id = COALESCE((
        SELECT r.affiliate_org_id
          FROM regions r
         WHERE r.id = stations.region_id AND r.org_id = stations.org_id
      ), org_id)
      WHERE affiliate_org_id IS NULL`);
  },
};
