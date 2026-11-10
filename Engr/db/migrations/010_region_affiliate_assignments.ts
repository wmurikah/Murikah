import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

/**
 * Tenant ownership is regions.org_id and MUST remain unchanged.
 * Affiliate is a separate, editable classification within that same group.
 * Existing regions and stations remain attached to their original tenant.
 *
 * Fill NULL/blank legacy codes without rewriting previously issued codes.
 */
export const regionAffiliateAssignments: Migration = {
  id: '010',
  description: 'Editable region affiliates and generated legacy region codes',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    const columns = await db.execute('PRAGMA table_info(regions)');
    if (!columns.rows.some((r) => String(r.name) === 'affiliate_org_id')) {
      await db.execute(
        'ALTER TABLE regions ADD COLUMN affiliate_org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL',
      );
    }
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_regions_affiliate
      ON regions(affiliate_org_id, org_id)`);
    // Legacy regions keep their original owner until reclassified explicitly.
    await db.execute(`UPDATE regions
      SET affiliate_org_id = org_id
      WHERE affiliate_org_id IS NULL`);

    // Reserve codes above the maximum already generated per owning organisation.
    const capacity = await db.execute(`WITH needed AS (
        SELECT org_id, COUNT(*) AS missing
          FROM regions
         WHERE code IS NULL OR TRIM(code) = ''
         GROUP BY org_id
      ), numbered AS MATERIALIZED (
        SELECT org_id, COALESCE(MAX(CAST(SUBSTR(code, 5) AS INTEGER)), 0) AS last_value
          FROM regions
         WHERE code GLOB 'REG-[0-9][0-9][0-9][0-9][0-9][0-9]'
         GROUP BY org_id
      )
      SELECT n.org_id FROM needed n
      LEFT JOIN numbered x ON x.org_id = n.org_id
      WHERE COALESCE(x.last_value, 0) + n.missing > 999999
      LIMIT 1`);
    if (capacity.rows.length) {
      throw new Error('Region code range exhausted; manual review required before migration 010.');
    }
    await db.execute(`WITH missing AS MATERIALIZED (
        SELECT id, org_id,
               ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY created_at, id) AS seq
          FROM regions
         WHERE code IS NULL OR TRIM(code) = ''
      ), maxima AS MATERIALIZED (
        SELECT org_id, COALESCE(MAX(CAST(SUBSTR(code, 5) AS INTEGER)), 0) AS last_value
          FROM regions
         WHERE code GLOB 'REG-[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
         GROUP BY org_id
      ), numbered AS MATERIALIZED (
        SELECT m.id, 'REG-' || printf('%06d', COALESCE(x.last_value, 0) + m.seq) AS generated
          FROM missing m LEFT JOIN maxima x ON x.org_id = m.org_id
      )
      UPDATE regions SET code = (
        SELECT generated FROM numbered WHERE numbered.id = regions.id
      )
      WHERE id IN (SELECT id FROM numbered)`);
  },
};
