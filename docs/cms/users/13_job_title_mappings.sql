-- ---------------------------------------------------------------------------
-- CMS: job title default mappings.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
--
-- Two catalogue tables that say what an administrator would USUALLY give a
-- person holding a job title:
--
--   job_title_access_role_mappings      title -> default access role
--   job_title_workflow_role_mappings    title -> default workflow role
--
-- Neither is read by the permission resolver, by the scope resolver, or by
-- approval routing. Nothing anywhere derives access from a job title. They are
-- a SUGGESTION the user administration screen offers when a title is chosen,
-- and the roles are only written when an administrator confirms them with an
-- explicit data scope. A title mapping can therefore never widen anybody's
-- access on its own, and an existing user's roles are unaffected by adding,
-- changing or deleting a mapping.
--
-- The chain stays what it already is:
--
--   job title --(default mapping)--> access role --> role_permissions --> permissions
--   job title --(default mapping)--> workflow role
--
-- There is no job_title_permissions table and no user_permissions table. A
-- permission belongs to a role and to nothing else, so there is exactly one
-- place to configure it and no way for a role to say NO while an override
-- says YES.
--
-- BOTH TABLES START EMPTY. Nothing is inferred from existing users: their
-- assignments and their roles remain authoritative, and an administrator
-- configures mappings deliberately.
--
-- ADDITIVE. No existing table is altered, rebuilt or backfilled.
-- SAFE TO RUN TWICE. NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_title_access_role_mappings (
    mapping_id TEXT PRIMARY KEY,
    job_title_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id TEXT,
    FOREIGN KEY (job_title_id) REFERENCES job_titles(job_title_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES access_roles(role_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(job_title_id, role_id)
);

CREATE INDEX IF NOT EXISTS ix_jt_role_map_title
    ON job_title_access_role_mappings(job_title_id, active);

CREATE TABLE IF NOT EXISTS job_title_workflow_role_mappings (
    mapping_id TEXT PRIMARY KEY,
    job_title_id TEXT NOT NULL,
    workflow_role_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id TEXT,
    FOREIGN KEY (job_title_id) REFERENCES job_titles(job_title_id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_role_id) REFERENCES workflow_roles(workflow_role_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(job_title_id, workflow_role_id)
);

CREATE INDEX IF NOT EXISTS ix_jt_wfrole_map_title
    ON job_title_workflow_role_mappings(job_title_id, active);

-- ---------------------------------------------------------------------------
-- VERIFICATION
--
-- (a) Both tables exist. Expect two rows.
-- ---------------------------------------------------------------------------
SELECT name
  FROM sqlite_master
 WHERE type = 'table'
   AND name IN ('job_title_access_role_mappings', 'job_title_workflow_role_mappings')
 ORDER BY name;

-- ---------------------------------------------------------------------------
-- (b) Both foreign keys resolve and the unique constraints are in place.
--     Expect four rows: two tables x two indexes (the implicit UNIQUE index
--     and the named one).
-- ---------------------------------------------------------------------------
SELECT tbl_name, name
  FROM sqlite_master
 WHERE type = 'index'
   AND tbl_name IN ('job_title_access_role_mappings', 'job_title_workflow_role_mappings')
 ORDER BY tbl_name, name;

-- ---------------------------------------------------------------------------
-- (c) No permission table was created by any other name. Expect NO rows.
--     A row here means somebody added a direct user or title permission
--     store, which is exactly what this design refuses.
-- ---------------------------------------------------------------------------
SELECT name
  FROM sqlite_master
 WHERE type = 'table'
   AND name IN ('user_permissions', 'job_title_permissions');
