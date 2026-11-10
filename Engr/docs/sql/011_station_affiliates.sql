-- ENGINEERING RHYTHM / TURSO - MIGRATION 011
-- Add station -> affiliate classification within the SAME owning tenant.
-- REQUIRED: a recoverable backup, and migrations 009 and 010 already applied.
-- Do not run the ALTER if affiliate_org_id already exists.
-- Do not mark 011 complete until every statement succeeds.
--
-- 0. PRECHECK
SELECT id, description, checksum FROM schema_migrations
 WHERE id IN ('009','010','011') ORDER BY id;
PRAGMA table_info(stations);
SELECT o.id, o.name, o.slug, o.parent_org_id,
       (SELECT COUNT(*) FROM stations s WHERE s.org_id = o.id) AS existing_stations
  FROM organisations o ORDER BY o.parent_org_id, o.name;

-- 1. Execute ONLY when PRAGMA table_info(stations) has no affiliate_org_id:
ALTER TABLE stations
 ADD COLUMN affiliate_org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL;

-- 2. Keep all original station IDs, tenant org_id and region IDs.
CREATE INDEX IF NOT EXISTS ix_stations_affiliate
 ON stations(org_id, affiliate_org_id, region_id);

UPDATE stations
   SET affiliate_org_id = COALESCE((
     SELECT r.affiliate_org_id FROM regions r
      WHERE r.id = stations.region_id AND r.org_id = stations.org_id
   ), org_id)
 WHERE affiliate_org_id IS NULL;

-- 3. Register only when the prior steps succeeded.
INSERT INTO schema_migrations (id, description, checksum)
 SELECT '011',
        'Stations classified by affiliate inside their existing tenant',
        '5479ab2934d894fa4d26c0cbb35b0bb94906f94be0173afacca9c5647c08a4ed'
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '011');

-- 4. VERIFY: counts must be zero for current data.
SELECT COUNT(*) AS stations_without_affiliate FROM stations
 WHERE affiliate_org_id IS NULL;
SELECT COUNT(*) AS station_region_affiliate_mismatches
  FROM stations s
  JOIN regions r ON r.id = s.region_id AND r.org_id = s.org_id
 WHERE COALESCE(s.affiliate_org_id, s.org_id) <>
       COALESCE(r.affiliate_org_id, r.org_id);
SELECT s.code, s.name, owner.name AS tenant, aff.name AS affiliate, r.name AS region
  FROM stations s
  JOIN organisations owner ON owner.id = s.org_id
  LEFT JOIN organisations aff ON aff.id = s.affiliate_org_id
  LEFT JOIN regions r ON r.id = s.region_id AND r.org_id = s.org_id
 ORDER BY tenant, affiliate, s.name;
SELECT id, description, checksum FROM schema_migrations WHERE id = '011';
PRAGMA foreign_key_check;
