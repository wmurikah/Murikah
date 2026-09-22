PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 1: durable lifecycle, scenario versioning and
-- learner membership. D1 remains authoritative for structured state.
CREATE TABLE IF NOT EXISTS scenario_packs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  career_family TEXT NOT NULL,
  role_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_versions (
  id TEXT PRIMARY KEY,
  scenario_pack_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  manifest_ref TEXT NOT NULL DEFAULT '',
  minimum_duration_days INTEGER NOT NULL DEFAULT 90 CHECK (minimum_duration_days > 0),
  expected_workload_band TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (scenario_pack_id, version),
  FOREIGN KEY (scenario_pack_id) REFERENCES scenario_packs(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_instances (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  scenario_pack_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'demo', 'test')),
  qualifying INTEGER NOT NULL CHECK (qualifying IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
  lifecycle_stage TEXT NOT NULL DEFAULT 'started',
  started_at INTEGER NOT NULL,
  minimum_duration_days INTEGER NOT NULL CHECK (minimum_duration_days >= 90),
  target_end_at INTEGER NOT NULL,
  stopped_at INTEGER,
  completed_at INTEGER,
  start_request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (learner_id, start_request_id),
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_pack_id) REFERENCES scenario_packs(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  CHECK (qualifying = 0 OR mode = 'standard'),
  CHECK (completed_at IS NULL),
  CHECK (target_end_at >= started_at)
) STRICT;

CREATE TABLE IF NOT EXISTS internship_memberships (
  internship_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('learner')),
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (internship_id, actor_id, role),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_activity (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('internship_started', 'internship_stopped', 'completion_duration_checked')
  ),
  event_time INTEGER NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scenario_versions_pack_status
  ON scenario_versions(scenario_pack_id, status, version DESC);

CREATE INDEX IF NOT EXISTS idx_internship_instances_learner_status
  ON internship_instances(learner_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_internship_instances_scenario_version
  ON internship_instances(scenario_version_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_one_active_qualifying_per_learner
  ON internship_instances(learner_id)
  WHERE status = 'active' AND qualifying = 1;

CREATE INDEX IF NOT EXISTS idx_internship_memberships_actor
  ON internship_memberships(actor_id, status, internship_id);

CREATE INDEX IF NOT EXISTS idx_internship_activity_internship_time
  ON internship_activity(internship_id, event_time DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_activity_request
  ON internship_activity(internship_id, event_type, request_id)
  WHERE request_id <> '';

-- Minimal published foundation pack. It contains no Phase 2 task/event graph;
-- it exists only so Phase 1 lifecycle/versioning can be exercised end to end.
INSERT OR IGNORE INTO scenario_packs(
  id, slug, title, career_family, role_title, status, created_at, updated_at
) VALUES (
  'sp_foundation_knowledge_work',
  'foundation-knowledge-work',
  'Knowledge Work Virtual Internship',
  'Knowledge Work',
  'Virtual Intern',
  'published',
  unixepoch(),
  unixepoch()
);

INSERT OR IGNORE INTO scenario_versions(
  id, scenario_pack_id, version, schema_version, status, manifest_ref,
  minimum_duration_days, expected_workload_band, content_hash, created_at, published_at
) VALUES (
  'sv_foundation_knowledge_work_v1',
  'sp_foundation_knowledge_work',
  1,
  1,
  'published',
  '',
  90,
  'standard',
  'phase1-foundation-no-task-graph',
  unixepoch(),
  unixepoch()
);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase1_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
