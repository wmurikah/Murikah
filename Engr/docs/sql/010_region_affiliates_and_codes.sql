-- Engineering Rhythm / Turso migration 010 (new install after migration 009)
-- The Hass Group tenant data is preserved: regions.org_id, stations.org_id,
-- station.region_id and every existing record ID are NEVER changed by this script.
-- Region affiliate selection is independent classification stored in affiliate_org_id.
--
-- FIRST: Back up the Engineering Turso database; confirm migration 009 exists
-- and 010 does not. Stop if 010 is already recorded.
SELECT id, description FROM schema_migrations WHERE id IN ('009','010') ORDER BY id;
PRAGMA table_info(regions);

-- 1. Run only when regions has no affiliate_org_id column.
ALTER TABLE regions
  ADD COLUMN affiliate_org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL;

-- 2. Index and backfill existing regions to their original Hass/affiliate owner.
CREATE INDEX IF NOT EXISTS ix_regions_affiliate
  ON regions(affiliate_org_id, org_id);
UPDATE regions SET affiliate_org_id = org_id
 WHERE affiliate_org_id IS NULL;

-- 3. Capacity check: this query MUST return no rows before backfilling codes.
WITH needed AS (
  SELECT org_id, COUNT(*) AS missing FROM regions
   WHERE code IS NULL OR TRIM(code) = '' GROUP BY org_id
), numbered AS (
  SELECT org_id, COALESCE(MAX(CAST(SUBSTR(code, 5) AS INTEGER)), 0) AS last_value
    FROM regions
   WHERE code GLOB 'REG-[0-9][0-9][0-9][0-9][0-9][0-9]'
   GROUP BY org_id
)
SELECT n.org_id AS insufficient_code_range
  FROM needed n LEFT JOIN numbered x ON x.org_id = n.org_id
 WHERE COALESCE(x.last_value, 0) + n.missing > 999999;

-- 4. Generate codes only for legacy NULL/blank entries, deterministically.
-- Previously recorded nonblank and manual codes are preserved.
WITH missing AS MATERIALIZED (
  SELECT id, org_id,
         ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY created_at, id) AS seq
    FROM regions
   WHERE code IS NULL OR TRIM(code) = ''
), maxima AS MATERIALIZED (
  SELECT org_id, COALESCE(MAX(CAST(SUBSTR(code, 5) AS INTEGER)), 0) AS last_value
    FROM regions
   WHERE code GLOB 'REG-[0-9][0-9][0-9][0-9][0-9][0-9]'
   GROUP BY org_id
), numbered AS MATERIALIZED (
  SELECT m.id, 'REG-' || printf('%06d', COALESCE(x.last_value, 0) + m.seq) AS generated
    FROM missing m LEFT JOIN maxima x ON x.org_id = m.org_id
)
UPDATE regions
   SET code = (SELECT generated FROM numbered WHERE numbered.id = regions.id)
 WHERE id IN (SELECT id FROM numbered);

-- 5. Record the source-file checksum ONLY when all steps above succeed.
INSERT INTO schema_migrations (id, description, checksum)
SELECT
  '010',
  'Editable region affiliates and generated legacy region codes',
  '48ea157ba1d3cc9e242a8c23a319a66085757bbbeb4adf89865684189b845faf'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '010');

-- 6. Verification. First two counts should both be zero.
SELECT COUNT(*) AS missing_region_codes FROM regions
 WHERE code IS NULL OR TRIM(code) = '';
SELECT COUNT(*) AS missing_affiliate_assignments FROM regions
 WHERE affiliate_org_id IS NULL;
SELECT m.id, m.description, m.checksum FROM schema_migrations m WHERE m.id = '010';
SELECT r.name, r.code, owner.name AS owning_tenant, aff.name AS affiliate
  FROM regions r
  JOIN organisations owner ON owner.id = r.org_id
  LEFT JOIN organisations aff ON aff.id = r.affiliate_org_id
 ORDER BY owner.name, r.name;
PRAGMA foreign_key_check;
