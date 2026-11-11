-- OPTIONAL DATA UPDATE: show "Hass Group" as the single parent tenant.
-- Execute ONLY in the Engineering Turso database after reviewing the preview.
-- No IDs, parent links, subscriptions, permissions or affiliate records change.
-- This intentionally does nothing if the existing name is not exactly "Hass"
-- or if multiple root organisations share that name.

SELECT id, name, slug, parent_org_id
  FROM organisations
 WHERE parent_org_id IS NULL AND lower(trim(name)) = 'hass';

UPDATE organisations
   SET name = 'Hass Group',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE parent_org_id IS NULL
   AND lower(trim(name)) = 'hass'
   AND (SELECT COUNT(*) FROM organisations
          WHERE parent_org_id IS NULL AND lower(trim(name)) = 'hass') = 1;

SELECT id, name, slug, parent_org_id
  FROM organisations
 WHERE parent_org_id IS NULL AND name = 'Hass Group';
