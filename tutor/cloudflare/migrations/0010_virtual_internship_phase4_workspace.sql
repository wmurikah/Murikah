PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 4: durable learner-facing workplace UI records only.
-- Canonical scenario truth remains in Phase 2. Model audit remains in Phase 3.
CREATE TABLE IF NOT EXISTS internship_message_threads (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  thread_kind TEXT NOT NULL CHECK (thread_kind IN ('workplace','mentor')),
  scenario_actor_id TEXT NOT NULL DEFAULT '',
  related_task_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (internship_id, thread_key),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  CHECK (
    (thread_kind = 'workplace' AND length(scenario_actor_id) > 0)
    OR
    (thread_kind = 'mentor' AND scenario_actor_id = '')
  )
) STRICT;

CREATE TABLE IF NOT EXISTS internship_messages (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('learner','actor','mentor','system')),
  sender_actor_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  related_task_id TEXT NOT NULL DEFAULT '',
  related_event_id TEXT NOT NULL DEFAULT '',
  related_model_invocation_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES internship_message_threads(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_reflections (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  period_key TEXT NOT NULL CHECK (length(period_key) BETWEEN 1 AND 80),
  prompt_version INTEGER NOT NULL DEFAULT 1 CHECK (prompt_version >= 1),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (internship_id, period_key),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_internship_message_threads_time
  ON internship_message_threads(internship_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_internship_messages_thread_time
  ON internship_messages(thread_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_internship_messages_internship_time
  ON internship_messages(internship_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_internship_reflections_time
  ON internship_reflections(internship_id, updated_at DESC, id);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase4_workspace_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
