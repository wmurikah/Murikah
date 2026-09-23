PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 3: model invocation audit metadata only.
-- Prompts, raw responses, provider credentials and chain-of-thought are deliberately not stored.
CREATE TABLE IF NOT EXISTS internship_ai_invocations (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  model_role TEXT NOT NULL CHECK (model_role IN ('actor','mentor','assessor','scenario_director')),
  scenario_actor_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL DEFAULT '',
  decision_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT '',
  orchestration_schema_version INTEGER NOT NULL CHECK (orchestration_schema_version = 1),
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  output_schema_version INTEGER NOT NULL DEFAULT 0 CHECK (output_schema_version >= 0),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
  output_hash TEXT NOT NULL DEFAULT '' CHECK (output_hash = '' OR length(output_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  first_token_ms INTEGER NOT NULL DEFAULT 0 CHECK (first_token_ms >= 0),
  total_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_ms >= 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  fallback_count INTEGER NOT NULL DEFAULT 0 CHECK (fallback_count BETWEEN 0 AND 1),
  error_code TEXT NOT NULL DEFAULT '',
  assistance_level INTEGER CHECK (assistance_level IS NULL OR assistance_level BETWEEN 0 AND 5),
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_internship_ai_invocations_internship_time
  ON internship_ai_invocations(internship_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internship_ai_invocations_role_time
  ON internship_ai_invocations(model_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internship_ai_invocations_actor_time
  ON internship_ai_invocations(internship_id, scenario_actor_id, created_at DESC);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase3_ai_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
