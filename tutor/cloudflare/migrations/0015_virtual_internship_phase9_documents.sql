PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 9: immutable completion documents and privacy-preserving verification.
CREATE TABLE IF NOT EXISTS internship_completion_documents (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  completion_record_id TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('performance_report','completion_letter')),
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  template_version TEXT NOT NULL CHECK (length(template_version) BETWEEN 1 AND 80),
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version > 0),
  source_snapshot_hash TEXT NOT NULL CHECK (length(source_snapshot_hash) = 64),
  source_payload_json TEXT NOT NULL CHECK (length(source_payload_json) BETWEEN 2 AND 300000),
  source_payload_hash TEXT NOT NULL CHECK (length(source_payload_hash) = 64),
  object_id TEXT NOT NULL UNIQUE,
  document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  verification_reference_id TEXT NOT NULL UNIQUE CHECK (length(verification_reference_id) BETWEEN 32 AND 96),
  verification_code_hash TEXT NOT NULL CHECK (length(verification_code_hash) = 64),
  issuance_status TEXT NOT NULL CHECK (issuance_status IN ('current','superseded')),
  issued_at INTEGER NOT NULL,
  superseded_at INTEGER,
  superseded_by_document_id TEXT,
  simulation_disclosure_version TEXT NOT NULL CHECK (length(simulation_disclosure_version) BETWEEN 1 AND 80),
  endorsement_json TEXT NOT NULL DEFAULT '{}' CHECK (length(endorsement_json) BETWEEN 2 AND 4000),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE (completion_record_id, document_type, document_version),
  UNIQUE (learner_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (completion_record_id) REFERENCES completion_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (object_id) REFERENCES tutor_objects(object_id) ON DELETE RESTRICT,
  CHECK (
    (issuance_status = 'current' AND superseded_at IS NULL AND superseded_by_document_id IS NULL)
    OR
    (issuance_status = 'superseded' AND superseded_at IS NOT NULL AND superseded_by_document_id IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_documents_one_current
  ON internship_completion_documents(completion_record_id, document_type)
  WHERE issuance_status = 'current';

CREATE INDEX IF NOT EXISTS idx_completion_documents_owner
  ON internship_completion_documents(learner_id, internship_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_completion_documents_verification
  ON internship_completion_documents(verification_reference_id);

CREATE INDEX IF NOT EXISTS idx_completion_documents_completion
  ON internship_completion_documents(completion_record_id, document_type, document_version DESC);

CREATE TRIGGER IF NOT EXISTS trg_completion_documents_immutable_fields
BEFORE UPDATE OF
  internship_id, learner_id, completion_record_id, document_type, document_version,
  template_version, source_schema_version, source_snapshot_hash, source_payload_json,
  source_payload_hash, object_id, document_sha256, size_bytes, content_type,
  verification_reference_id, verification_code_hash, issued_at,
  simulation_disclosure_version, endorsement_json, request_id, created_at
ON internship_completion_documents
BEGIN
  SELECT RAISE(ABORT, 'completion_document_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_completion_documents_supersession_only
BEFORE UPDATE ON internship_completion_documents
WHEN NOT (
  OLD.issuance_status = 'current'
  AND NEW.issuance_status = 'superseded'
  AND OLD.superseded_at IS NULL
  AND NEW.superseded_at IS NOT NULL
  AND OLD.superseded_by_document_id IS NULL
  AND NEW.superseded_by_document_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'completion_document_update_not_allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_completion_documents_no_delete
BEFORE DELETE ON internship_completion_documents
BEGIN
  SELECT RAISE(ABORT, 'completion_document_immutable');
END;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase9_document_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
