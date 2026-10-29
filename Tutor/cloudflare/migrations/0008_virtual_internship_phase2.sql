PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 2: immutable scenario definitions and deterministic runtime state.
CREATE TABLE IF NOT EXISTS scenario_version_content (
  scenario_version_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  manifest_ref TEXT NOT NULL UNIQUE,
  canonical_json TEXT NOT NULL CHECK (length(canonical_json) > 1 AND length(canonical_json) <= 1048576),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  installed_at INTEGER NOT NULL,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_actors (
  scenario_version_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  actor_class TEXT NOT NULL,
  job_title TEXT NOT NULL,
  department_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (scenario_version_id, actor_id),
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_version_content(scenario_version_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_facts (
  scenario_version_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  initial_value_json TEXT NOT NULL,
  mutability TEXT NOT NULL CHECK (mutability IN ('immutable', 'mutable')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','learner_visible','department','role','actor_specific','hidden_truth')),
  visibility_scopes_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  initially_revealed INTEGER NOT NULL CHECK (initially_revealed IN (0, 1)),
  future_only INTEGER NOT NULL CHECK (future_only IN (0, 1)),
  PRIMARY KEY (scenario_version_id, fact_id),
  UNIQUE (scenario_version_id, fact_key),
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_version_content(scenario_version_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_actor_knowledge (
  scenario_version_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  PRIMARY KEY (scenario_version_id, actor_id, fact_id),
  FOREIGN KEY (scenario_version_id, actor_id) REFERENCES scenario_actors(scenario_version_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id, fact_id) REFERENCES scenario_facts(scenario_version_id, fact_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_task_definitions (
  scenario_version_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  authored_sequence INTEGER NOT NULL CHECK (authored_sequence > 0),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  assigned_by_actor_id TEXT NOT NULL,
  initial_state TEXT NOT NULL CHECK (initial_state IN ('locked','available')),
  due_offset_days INTEGER NOT NULL CHECK (due_offset_days >= 0),
  definition_json TEXT NOT NULL,
  PRIMARY KEY (scenario_version_id, task_id),
  UNIQUE (scenario_version_id, authored_sequence),
  FOREIGN KEY (scenario_version_id, assigned_by_actor_id) REFERENCES scenario_actors(scenario_version_id, actor_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_task_dependencies (
  scenario_version_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (scenario_version_id, task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (scenario_version_id, task_id) REFERENCES scenario_task_definitions(scenario_version_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id, depends_on_task_id) REFERENCES scenario_task_definitions(scenario_version_id, task_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_event_definitions (
  scenario_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  authored_sequence INTEGER NOT NULL CHECK (authored_sequence > 0),
  event_type TEXT NOT NULL,
  priority INTEGER NOT NULL,
  once_only INTEGER NOT NULL CHECK (once_only = 1),
  audit_label TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  PRIMARY KEY (scenario_version_id, event_id),
  UNIQUE (scenario_version_id, authored_sequence),
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_version_content(scenario_version_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_event_triggers (
  scenario_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  trigger_index INTEGER NOT NULL CHECK (trigger_index >= 0),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('time_elapsed_days','task_state','all_dependencies_completed','fact_equals','prior_event','decision')),
  trigger_json TEXT NOT NULL,
  PRIMARY KEY (scenario_version_id, event_id, trigger_index),
  FOREIGN KEY (scenario_version_id, event_id) REFERENCES scenario_event_definitions(scenario_version_id, event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_decision_options (
  scenario_version_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (scenario_version_id, decision_id, option_id),
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_version_content(scenario_version_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_scenario_state (
  internship_id TEXT PRIMARY KEY,
  scenario_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initializing','ready','error')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  initialized_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_version_content(scenario_version_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_scenario_facts (
  internship_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  current_value_json TEXT NOT NULL,
  is_revealed INTEGER NOT NULL CHECK (is_revealed IN (0, 1)),
  learner_revealed INTEGER NOT NULL CHECK (learner_revealed IN (0, 1)),
  updated_revision INTEGER NOT NULL CHECK (updated_revision >= 0),
  PRIMARY KEY (internship_id, fact_id),
  FOREIGN KEY (internship_id) REFERENCES internship_scenario_state(internship_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_tasks (
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('locked','available','in_progress','completed','cancelled')),
  due_at INTEGER NOT NULL,
  updated_revision INTEGER NOT NULL CHECK (updated_revision >= 0),
  PRIMARY KEY (internship_id, task_id),
  FOREIGN KEY (internship_id) REFERENCES internship_scenario_state(internship_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_event_state (
  internship_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  fired_count INTEGER NOT NULL DEFAULT 0 CHECK (fired_count >= 0),
  last_fired_at INTEGER,
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (internship_id, event_id),
  FOREIGN KEY (internship_id) REFERENCES internship_scenario_state(internship_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_decisions (
  internship_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (internship_id, decision_id),
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_scenario_state(internship_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_event_firings (
  internship_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  firing_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  revision_before INTEGER NOT NULL,
  revision_after INTEGER NOT NULL,
  applied_mutations_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY (internship_id, event_id),
  UNIQUE (internship_id, firing_id),
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_scenario_state(internship_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_state_changes (
  internship_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  changed_at INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (internship_id, revision),
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_scenario_state(internship_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scenario_actors_version_class ON scenario_actors(scenario_version_id, actor_class);
CREATE INDEX IF NOT EXISTS idx_scenario_facts_version_visibility ON scenario_facts(scenario_version_id, visibility, future_only);
CREATE INDEX IF NOT EXISTS idx_scenario_actor_knowledge_actor ON scenario_actor_knowledge(scenario_version_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_scenario_task_dependencies_prereq ON scenario_task_dependencies(scenario_version_id, depends_on_task_id, task_id);
CREATE INDEX IF NOT EXISTS idx_scenario_event_order ON scenario_event_definitions(scenario_version_id, priority DESC, authored_sequence ASC, event_id ASC);
CREATE INDEX IF NOT EXISTS idx_scenario_event_triggers_type ON scenario_event_triggers(scenario_version_id, trigger_type, event_id);
CREATE INDEX IF NOT EXISTS idx_internship_tasks_status ON internship_tasks(internship_id, status, task_id);
CREATE INDEX IF NOT EXISTS idx_internship_event_firings_time ON internship_event_firings(internship_id, fired_at, event_id);
CREATE INDEX IF NOT EXISTS idx_internship_state_changes_time ON internship_state_changes(internship_id, changed_at, revision);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase2_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
