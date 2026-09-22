PRAGMA foreign_keys = ON;

-- Phase 1 persistence foundation for Murikah Virtual Internship.
-- Structured state lives in D1. Larger scenario assets and learner work products
-- use private R2 keys recorded here with explicit learner/internship ownership.

CREATE TABLE IF NOT EXISTS virtual_internship_scenarios (
  scenario_id TEXT PRIMARY KEY,
  career_family TEXT NOT NULL,
  role_slug TEXT NOT NULL,
  role_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  current_version INTEGER NOT NULL DEFAULT 0
    CHECK (current_version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_internship_scenarios_role_slug
  ON virtual_internship_scenarios(role_slug);

CREATE TABLE IF NOT EXISTS virtual_internship_scenario_versions (
  scenario_version_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  manifest_json TEXT NOT NULL,
  r2_prefix TEXT NOT NULL UNIQUE,
  minimum_duration_days INTEGER NOT NULL CHECK (minimum_duration_days >= 1),
  expected_weekly_hours INTEGER NOT NULL DEFAULT 8
    CHECK (expected_weekly_hours BETWEEN 1 AND 40),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  qualifying INTEGER NOT NULL DEFAULT 1 CHECK (qualifying IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (scenario_id)
    REFERENCES virtual_internship_scenarios(scenario_id)
    ON DELETE RESTRICT,
  UNIQUE (scenario_id, version_number),
  CHECK (is_demo = 0 OR qualifying = 0),
  CHECK (qualifying = 0 OR minimum_duration_days >= 90)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_virtual_internship_scenario_versions_lookup
  ON virtual_internship_scenario_versions(
    scenario_id,
    status,
    version_number DESC
  );

CREATE TABLE IF NOT EXISTS virtual_internships (
  internship_id TEXT PRIMARY KEY,
  learner_actor_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding', 'active', 'paused', 'stopped', 'completed')),
  active_slot INTEGER CHECK (active_slot IS NULL OR active_slot = 1),
  qualifying INTEGER NOT NULL DEFAULT 1 CHECK (qualifying IN (0, 1)),
  minimum_duration_days INTEGER NOT NULL CHECK (minimum_duration_days >= 1),
  expected_weekly_hours INTEGER NOT NULL DEFAULT 8
    CHECK (expected_weekly_hours BETWEEN 1 AND 40),
  started_at INTEGER NOT NULL,
  target_end_at INTEGER NOT NULL,
  completed_at INTEGER,
  stopped_at INTEGER,
  progress_stage TEXT NOT NULL DEFAULT 'onboarding',
  r2_prefix TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (learner_actor_id)
    REFERENCES tutor_accounts(actor_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (scenario_id)
    REFERENCES virtual_internship_scenarios(scenario_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id)
    REFERENCES virtual_internship_scenario_versions(scenario_version_id)
    ON DELETE RESTRICT,
  CHECK (qualifying = 0 OR minimum_duration_days >= 90),
  CHECK (
    qualifying = 0 OR
    target_end_at >= started_at + (minimum_duration_days * 86400)
  ),
  CHECK (
    (status IN ('onboarding', 'active', 'paused') AND active_slot = 1) OR
    (status IN ('stopped', 'completed') AND active_slot IS NULL)
  )
) STRICT;

-- NULL values do not collide in SQLite, so historical/stopped internships are
-- unlimited while active_slot=1 enforces one live internship per learner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_internships_one_active
  ON virtual_internships(learner_actor_id, active_slot);

CREATE INDEX IF NOT EXISTS idx_virtual_internships_learner
  ON virtual_internships(learner_actor_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_virtual_internships_scenario_version
  ON virtual_internships(scenario_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS virtual_internship_memberships (
  internship_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  membership_role TEXT NOT NULL
    CHECK (membership_role IN ('learner', 'reviewer', 'institution_admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (internship_id, actor_id),
  FOREIGN KEY (internship_id)
    REFERENCES virtual_internships(internship_id)
    ON DELETE CASCADE,
  FOREIGN KEY (actor_id)
    REFERENCES tutor_accounts(actor_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_virtual_internship_memberships_actor
  ON virtual_internship_memberships(actor_id, membership_role, created_at DESC);

CREATE TABLE IF NOT EXISTS virtual_internship_status_history (
  history_id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (internship_id)
    REFERENCES virtual_internships(internship_id)
    ON DELETE CASCADE,
  FOREIGN KEY (actor_id)
    REFERENCES tutor_accounts(actor_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_virtual_internship_status_history
  ON virtual_internship_status_history(internship_id, created_at ASC);

CREATE TABLE IF NOT EXISTS virtual_internship_objects (
  object_id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  learner_actor_id TEXT NOT NULL,
  object_type TEXT NOT NULL
    CHECK (object_type IN (
      'artifact',
      'attachment',
      'workspace',
      'reflection',
      'report',
      'export'
    )),
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  object_version INTEGER NOT NULL DEFAULT 1 CHECK (object_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (internship_id)
    REFERENCES virtual_internships(internship_id)
    ON DELETE CASCADE,
  FOREIGN KEY (learner_actor_id)
    REFERENCES tutor_accounts(actor_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_virtual_internship_objects_owner
  ON virtual_internship_objects(
    learner_actor_id,
    internship_id,
    object_type,
    updated_at DESC
  );

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
