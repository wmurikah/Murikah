PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tutor_actors (
  actor_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('guest', 'member', 'admin')),
  username TEXT NOT NULL DEFAULT '',
  guest_session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  converted_at INTEGER
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tutor_actors_username
  ON tutor_actors(username)
  WHERE username <> '';

CREATE TABLE IF NOT EXISTS tutor_actor_profiles (
  actor_id TEXT PRIMARY KEY REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  preferred_language TEXT NOT NULL DEFAULT '',
  learner_level TEXT NOT NULL DEFAULT '',
  learning_goal TEXT NOT NULL DEFAULT '',
  learner_role TEXT NOT NULL DEFAULT '',
  education_level TEXT NOT NULL DEFAULT '',
  age_band TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  demographics_consent INTEGER NOT NULL DEFAULT 0 CHECK (demographics_consent IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tutor_training_consent (
  actor_id TEXT PRIMARY KEY REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  training_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (training_opt_in IN (0, 1)),
  research_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (research_opt_in IN (0, 1)),
  consent_version TEXT NOT NULL DEFAULT '',
  consented_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tutor_conversations (
  conversation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  surface TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_turn_id TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_conversations_actor
  ON tutor_conversations(actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tutor_turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES tutor_conversations(conversation_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'running', 'streaming', 'completed', 'failed', 'timed_out', 'cancelled')
  ),
  capability TEXT NOT NULL DEFAULT 'chat',
  language TEXT NOT NULL DEFAULT '',
  prompt_summary TEXT NOT NULL DEFAULT '',
  response_summary TEXT NOT NULL DEFAULT '',
  model_profile_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  first_token_ms INTEGER NOT NULL DEFAULT 0 CHECK (first_token_ms >= 0),
  total_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_ms >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  regenerate INTEGER NOT NULL DEFAULT 0 CHECK (regenerate IN (0, 1)),
  training_eligible INTEGER NOT NULL DEFAULT 0 CHECK (training_eligible IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_turns_conversation
  ON tutor_turns(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tutor_turns_actor
  ON tutor_turns(actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_turns_training
  ON tutor_turns(training_eligible, status, created_at);

CREATE TABLE IF NOT EXISTS tutor_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES tutor_conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES tutor_turns(turn_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  content_summary TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_messages_conversation
  ON tutor_messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tutor_messages_turn
  ON tutor_messages(turn_id, role);

CREATE TABLE IF NOT EXISTS tutor_feedback (
  feedback_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES tutor_turns(turn_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating IS NULL OR rating IN (-1, 0, 1)),
  category TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_feedback_turn
  ON tutor_feedback(turn_id, created_at DESC);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('learning_journal_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
