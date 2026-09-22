PRAGMA foreign_keys = ON;

-- Follow-up Fast Path V2: durable compact conversation context and per-turn
-- latency telemetry. The context packet is prepared when a turn finishes so
-- the next follow-up does not need to replay an ever-growing raw transcript.

CREATE TABLE IF NOT EXISTS tutor_conversation_context (
  conversation_id TEXT PRIMARY KEY
    REFERENCES tutor_conversations(conversation_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL
    REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  facts_json TEXT NOT NULL DEFAULT '[]',
  open_threads_json TEXT NOT NULL DEFAULT '[]',
  recent_messages_json TEXT NOT NULL DEFAULT '[]',
  preferred_provider TEXT NOT NULL DEFAULT '',
  preferred_model TEXT NOT NULL DEFAULT '',
  source_message_count INTEGER NOT NULL DEFAULT 0 CHECK (source_message_count >= 0),
  packet_version INTEGER NOT NULL DEFAULT 1 CHECK (packet_version >= 1),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_conversation_context_actor
  ON tutor_conversation_context(actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tutor_turn_metrics (
  turn_id TEXT PRIMARY KEY
    REFERENCES tutor_turns(turn_id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL
    REFERENCES tutor_conversations(conversation_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL
    REFERENCES tutor_actors(actor_id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL DEFAULT 1 CHECK (turn_number >= 1),
  is_followup INTEGER NOT NULL DEFAULT 0 CHECK (is_followup IN (0, 1)),
  lane TEXT NOT NULL DEFAULT '',
  route_reason TEXT NOT NULL DEFAULT '',
  history_chars INTEGER NOT NULL DEFAULT 0 CHECK (history_chars >= 0),
  history_messages INTEGER NOT NULL DEFAULT 0 CHECK (history_messages >= 0),
  context_packet_chars INTEGER NOT NULL DEFAULT 0 CHECK (context_packet_chars >= 0),
  context_build_ms INTEGER NOT NULL DEFAULT 0 CHECK (context_build_ms >= 0),
  output_token_budget INTEGER NOT NULL DEFAULT 0 CHECK (output_token_budget >= 0),
  first_token_deadline_ms INTEGER NOT NULL DEFAULT 0 CHECK (first_token_deadline_ms >= 0),
  stream_idle_timeout_ms INTEGER NOT NULL DEFAULT 0 CHECK (stream_idle_timeout_ms >= 0),
  provider TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  first_token_ms INTEGER NOT NULL DEFAULT 0 CHECK (first_token_ms >= 0),
  stream_ms INTEGER NOT NULL DEFAULT 0 CHECK (stream_ms >= 0),
  continuation_count INTEGER NOT NULL DEFAULT 0 CHECK (continuation_count >= 0),
  total_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_ms >= 0),
  incomplete INTEGER NOT NULL DEFAULT 0 CHECK (incomplete IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_turn_metrics_conversation
  ON tutor_turn_metrics(conversation_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_tutor_turn_metrics_followup
  ON tutor_turn_metrics(is_followup, total_ms DESC, first_token_ms DESC);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('learning_journal_schema_version', '2', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('followup_fast_path_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
