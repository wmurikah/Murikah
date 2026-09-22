PRAGMA foreign_keys = ON;

-- Murikah Tutor Virtual Internship Phase 1.
-- D1 is authoritative for lifecycle/version/ownership state. R2 objects are not
-- created by this migration; when later phases create them, tutor_objects from
-- 0004 remains the single authoritative ownership registry.
CREATE TABLE IF NOT EXISTS scenario_packs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  career_family TEXT NOT NULL,
  role_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_versions (
  id TEXT PRIMARY KEY,
  scenario_pack_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  minimum_duration_days INTEGER NOT NULL CHECK (minimum_duration_days >= 1),
  expected_workload_band TEXT NOT NULL DEFAULT 'standard',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  FOREIGN KEY (scenario_pack_id) REFERENCES scenario_packs(id) ON DELETE RESTRICT,
  UNIQUE (scenario_pack_id, version),
  UNIQUE (scenario_pack_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scenario_versions_pack_status_version
  ON scenario_versions(scenario_pack_id, status, version DESC);

CREATE TABLE IF NOT EXISTS internship_instances (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  scenario_pack_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (mode IN ('standard', 'demo')),
  qualifying INTEGER NOT NULL DEFAULT 1
    CHECK (qualifying IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stopped')),
  lifecycle_stage TEXT NOT NULL DEFAULT 'started'
    CHECK (lifecycle_stage IN ('started', 'stopped')),
  started_at INTEGER NOT NULL,
  minimum_duration_days INTEGER NOT NULL
    CHECK (minimum_duration_days >= 1),
  target_end_at INTEGER NOT NULL,
  stopped_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_pack_id) REFERENCES scenario_packs(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_pack_id, scenario_version_id)
    REFERENCES scenario_versions(scenario_pack_id, id) ON DELETE RESTRICT,
  CHECK (mode <> 'demo' OR qualifying = 0),
  CHECK (qualifying = 0 OR minimum_duration_days >= 90),
  CHECK (target_end_at >= started_at + (minimum_duration_days * 86400)),
  CHECK (
    (status = 'active' AND stopped_at IS NULL AND lifecycle_stage = 'started')
    OR
    (status = 'stopped' AND stopped_at IS NOT NULL AND lifecycle_stage = 'stopped')
  )
) STRICT;

-- D1/SQLite partial uniqueness is the final concurrency guard. Two simultaneous
-- qualifying starts for one learner cannot both become active.
CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_instances_one_active_qualifying
  ON internship_instances(learner_id)
  WHERE status = 'active' AND qualifying = 1;

CREATE INDEX IF NOT EXISTS idx_internship_instances_learner_status
  ON internship_instances(learner_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_internship_instances_scenario_version
  ON internship_instances(scenario_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS internship_memberships (
  internship_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('learner', 'supervisor', 'institution')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (internship_id, actor_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_internship_memberships_actor
  ON internship_memberships(actor_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_memberships_one_active_learner
  ON internship_memberships(internship_id)
  WHERE role = 'learner' AND status = 'active';

CREATE TABLE IF NOT EXISTS internship_activity (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  UNIQUE (actor_id, event_type, request_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_internship_activity_internship_time
  ON internship_activity(internship_id, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_activity_single_start
  ON internship_activity(internship_id)
  WHERE event_type = 'internship_started';

CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_activity_single_stop
  ON internship_activity(internship_id)
  WHERE event_type = 'internship_stopped';

-- Minimal Phase 1 lifecycle fixture. It contains no task/event graph or fake
-- assignments; it exists only so the start/status/stop persistence contract can
-- be exercised before Phase 2 scenario-engine work begins.
INSERT OR IGNORE INTO scenario_packs(
  id, slug, title, career_family, role_title, status, created_at, updated_at
) VALUES (
  'scenario_phase1_foundation',
  'phase1-foundation-internship',
  'Virtual Internship Foundation',
  'General digital knowledge work',
  'Virtual Intern',
  'published',
  unixepoch(),
  unixepoch()
);

INSERT OR IGNORE INTO scenario_versions(
  id, scenario_pack_id, version, schema_version, status, manifest_json,
  minimum_duration_days, expected_workload_band, content_hash, created_at, published_at
) VALUES (
  'scenario_phase1_foundation_v1',
  'scenario_phase1_foundation',
  1,
  1,
  'published',
  '{"phase":1,"foundation_only":true,"assignments_enabled":false}',
  90,
  'standard',
  'phase1-foundation-v1',
  unixepoch(),
  unixepoch()
);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase1_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
