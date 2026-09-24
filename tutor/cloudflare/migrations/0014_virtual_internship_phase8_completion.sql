PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 8: deterministic qualifying completion.
--
-- D1 enforces foreign keys inside migrations, so the heavily referenced
-- internship_instances table is extended additively instead of being dropped.
-- The original Phase 1 completed_at column is retained as an always-NULL
-- compatibility guard; a new authoritative completed_at column is added.
ALTER TABLE internship_instances RENAME COLUMN completed_at TO phase1_completed_at_guard;
ALTER TABLE internship_instances ADD COLUMN completed_at INTEGER;

DROP INDEX IF EXISTS idx_internship_instances_learner_status;
DROP INDEX IF EXISTS idx_internship_one_active_qualifying_per_learner;
ALTER TABLE internship_instances RENAME COLUMN status TO phase1_status;
ALTER TABLE internship_instances ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','stopped','completed'));
UPDATE internship_instances SET status = phase1_status;
ALTER TABLE internship_instances DROP COLUMN phase1_status;

CREATE INDEX IF NOT EXISTS idx_internship_instances_learner_status
  ON internship_instances(learner_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_one_active_qualifying_per_learner
  ON internship_instances(learner_id)
  WHERE status = 'active' AND qualifying = 1;

DROP INDEX IF EXISTS idx_internship_memberships_actor;
ALTER TABLE internship_memberships RENAME COLUMN status TO phase1_status;
ALTER TABLE internship_memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','stopped','completed'));
UPDATE internship_memberships SET status = phase1_status;
ALTER TABLE internship_memberships DROP COLUMN phase1_status;
CREATE INDEX IF NOT EXISTS idx_internship_memberships_actor
  ON internship_memberships(actor_id, status, internship_id);

DROP INDEX IF EXISTS idx_internship_activity_request;
ALTER TABLE internship_activity RENAME COLUMN event_type TO phase1_event_type;
ALTER TABLE internship_activity ADD COLUMN event_type TEXT NOT NULL DEFAULT 'completion_duration_checked'
  CHECK (event_type IN ('internship_started','internship_stopped','completion_duration_checked','internship_completed'));
UPDATE internship_activity SET event_type = phase1_event_type;
ALTER TABLE internship_activity DROP COLUMN phase1_event_type;
CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_activity_request
  ON internship_activity(internship_id, event_type, request_id)
  WHERE request_id <> '';

-- Completion policy is immutable and pinned to one scenario version.
-- Existing published versions are not rewritten by this migration.
CREATE TABLE IF NOT EXISTS scenario_completion_policies (
  scenario_version_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  policy_json TEXT NOT NULL CHECK (length(policy_json) BETWEEN 2 AND 100000),
  policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 64),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_scenario_completion_policy_no_update
BEFORE UPDATE ON scenario_completion_policies
BEGIN SELECT RAISE(ABORT, 'completion_policy_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_scenario_completion_policy_no_delete
BEFORE DELETE ON scenario_completion_policies
BEGIN SELECT RAISE(ABORT, 'completion_policy_immutable'); END;

CREATE TABLE IF NOT EXISTS completion_records (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL UNIQUE,
  learner_id TEXT NOT NULL,
  scenario_pack_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  completion_policy_schema_version INTEGER NOT NULL CHECK (completion_policy_schema_version = 1),
  completion_policy_hash TEXT NOT NULL CHECK (length(completion_policy_hash) = 64),
  completed_at INTEGER NOT NULL,
  required_duration_days INTEGER NOT NULL CHECK (required_duration_days > 0),
  gate_snapshot_json TEXT NOT NULL CHECK (length(gate_snapshot_json) BETWEEN 2 AND 200000),
  gate_snapshot_hash TEXT NOT NULL CHECK (length(gate_snapshot_hash) = 64),
  evaluator_version TEXT NOT NULL CHECK (length(evaluator_version) BETWEEN 1 AND 80),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  passport_aggregation_ruleset_versions_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(passport_aggregation_ruleset_versions_json) <= 16000),
  evidence_ruleset_versions_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(evidence_ruleset_versions_json) <= 16000),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(evidence_refs_json) <= 100000),
  created_at INTEGER NOT NULL,
  UNIQUE (learner_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_pack_id) REFERENCES scenario_packs(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_completion_records_learner_time
  ON completion_records(learner_id, completed_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_completion_records_scenario
  ON completion_records(scenario_version_id, completed_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_completion_records_no_update
BEFORE UPDATE ON completion_records
BEGIN SELECT RAISE(ABORT, 'completion_record_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_completion_records_no_delete
BEFORE DELETE ON completion_records
BEGIN SELECT RAISE(ABORT, 'completion_record_immutable'); END;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase8_completion_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
