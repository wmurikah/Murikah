PRAGMA foreign_keys = ON;

-- Tutor-wide member personalization. preferred_name is explicit learner choice;
-- preferred_name_decided_at distinguishes "never answered" from "cleared later".
ALTER TABLE tutor_accounts ADD COLUMN preferred_name TEXT CHECK (preferred_name IS NULL OR length(preferred_name) <= 64);
ALTER TABLE tutor_accounts ADD COLUMN preferred_name_decided_at INTEGER;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('tutor_personalization_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
