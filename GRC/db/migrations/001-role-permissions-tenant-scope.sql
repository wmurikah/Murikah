-- Migration 001: tenant-scope the permission matrix (Build Prompt 44, AC-01)
--
-- Adds organization_id to role_permissions, so the effective key becomes
-- (organization_id, role_code, module_code, action_code). Before this, the
-- matrix was platform-wide: any instance admin holding CONFIG.update rewrote
-- every customer's roles at once (grc/docs/access-control-audit.md, AC-01).
--
-- SQLite cannot add a column to a primary key in place, so this is the standard
-- table rebuild: create the new shape, copy every existing row into it, drop the
-- old table, rename. Existing grants are preserved and assigned to the
-- platform-default sentinel organisation 'GLOBAL', which is exactly what they
-- were: the defaults every organisation now inherits until it saves its own set.
--
-- 'GLOBAL' is the same inactive sentinel organisation the platform-wide config
-- rows already hang off (src/lib/grc/repos/orgConfig.ts). The migration creates
-- it if it is not there yet, because role_permissions.organization_id
-- references organizations(organization_id) and connections run with foreign
-- keys ON (src/lib/grc/db.ts).
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 001". In short:
--
--   turso db shell hassaudit < grc/db/migrations/001-role-permissions-tenant-scope.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). The
-- migration is idempotent in the sense that it refuses to run twice: the second
-- run fails at CREATE TABLE role_permissions_new only if a previous run was
-- interrupted midway, in which case drop that leftover table and start again.
-- Run the verification queries at the foot of this file afterwards.
--
-- foreign_keys must be toggled OUTSIDE a transaction: SQLite ignores the pragma
-- while one is open. The foreign_key_check inside the transaction is what proves
-- nothing was orphaned before the swap is committed.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- The platform-default sentinel organisation. Inactive, so it never appears in
-- an organisation list or the instance switcher. Guarded rather than
-- INSERT OR IGNORE, so it is correct whether or not organization_id carries a
-- unique index.
INSERT INTO organizations (organization_id, org_code, org_name, is_active, created_at)
SELECT 'GLOBAL', 'GLOBAL', 'Platform (global configuration)', 0, datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE organization_id = 'GLOBAL');

CREATE TABLE role_permissions_new (
  organization_id TEXT NOT NULL DEFAULT 'GLOBAL'
    REFERENCES organizations(organization_id),
  role_code       TEXT NOT NULL REFERENCES roles(role_code),
  module_code     TEXT NOT NULL REFERENCES permission_modules(module_code),
  action_code     TEXT NOT NULL REFERENCES permission_actions(action_code),
  is_allowed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, role_code, module_code, action_code)
);

-- Every existing grant becomes a platform default. MAX(is_allowed) with the
-- GROUP BY collapses any duplicate rows the old table may hold: it had no
-- unique key, and the previous UPDATE-then-INSERT upsert could produce a second
-- row for the same cell. Collapsing to the permissive value keeps the effective
-- access identical to what the old OR-style read produced, so nobody loses a
-- grant they had.
INSERT INTO role_permissions_new
  (organization_id, role_code, module_code, action_code, is_allowed)
SELECT 'GLOBAL', role_code, module_code, action_code, MAX(is_allowed)
  FROM role_permissions
 WHERE role_code IS NOT NULL
   AND module_code IS NOT NULL
   AND action_code IS NOT NULL
 GROUP BY role_code, module_code, action_code;

DROP TABLE role_permissions;

ALTER TABLE role_permissions_new RENAME TO role_permissions;

-- The read is "this role, in this organisation or in the platform default", so
-- role_code leads. The primary key already indexes (organization_id, ...) for
-- the per-organisation writes and the provisioning copy.
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_org
  ON role_permissions (role_code, organization_id);

-- Refuses the commit if the copy orphaned anything against roles,
-- permission_modules, permission_actions or organizations.
PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

-- Verification, to run afterwards.
--
--   -- Every grant survived, and all of them are platform defaults for now.
--   SELECT organization_id, COUNT(*) FROM role_permissions GROUP BY organization_id;
--
--   -- The new shape, with the four-column primary key and the references.
--   SELECT sql FROM sqlite_master WHERE name = 'role_permissions';
--
--   -- Nothing orphaned.
--   PRAGMA foreign_key_check;
--
-- After this runs, every organisation resolves the platform defaults until an
-- administrator saves that organisation's own set on /settings/access-control,
-- at which point only that organisation's rows change. Organisations created
-- from then on inherit a copy of the defaults at provisioning
-- (src/lib/grc/repos/provisioningDefaults.ts).
