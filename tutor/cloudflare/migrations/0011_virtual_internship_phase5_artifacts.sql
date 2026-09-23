PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 5: learner work artifacts, immutable versions,
-- explicit submissions, workflow-only reviews and durable activity.
CREATE TABLE IF NOT EXISTS internship_task_acknowledgements (
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  PRIMARY KEY (internship_id, task_id),
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id, task_id) REFERENCES internship_tasks(internship_id, task_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_artifacts (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  deliverable_type TEXT NOT NULL CHECK (length(deliverable_type) BETWEEN 1 AND 64),
  artifact_type TEXT NOT NULL CHECK (length(artifact_type) BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','changes_requested','accepted')),
  current_version_id TEXT,
  current_version_number INTEGER NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
  accepted_submission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  create_request_id TEXT NOT NULL CHECK (length(create_request_id) BETWEEN 3 AND 128),
  UNIQUE (internship_id, task_id, deliverable_type),
  UNIQUE (internship_id, create_request_id),
  FOREIGN KEY (internship_id, task_id) REFERENCES internship_tasks(internship_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_version_id) REFERENCES internship_artifact_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (accepted_submission_id) REFERENCES internship_artifact_submissions(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  object_id TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL DEFAULT '' CHECK (length(original_filename) <= 255),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  source_type TEXT NOT NULL CHECK (source_type IN ('text','upload')),
  prior_review_id TEXT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (artifact_id, version_number),
  UNIQUE (artifact_id, request_id),
  FOREIGN KEY (artifact_id) REFERENCES internship_artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (internship_id, task_id) REFERENCES internship_tasks(internship_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (object_id) REFERENCES tutor_objects(object_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_review_id) REFERENCES internship_artifact_reviews(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_artifact_submissions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  submission_number INTEGER NOT NULL CHECK (submission_number > 0),
  prior_submission_id TEXT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  submitted_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted','under_review','changes_requested','accepted')),
  UNIQUE (artifact_id, submission_number),
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (artifact_id) REFERENCES internship_artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_version_id) REFERENCES internship_artifact_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_submission_id) REFERENCES internship_artifact_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (internship_id, task_id) REFERENCES internship_tasks(internship_id, task_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_artifact_reviews (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  submission_id TEXT NOT NULL UNIQUE,
  reviewer_actor_id TEXT NOT NULL,
  review_type TEXT NOT NULL CHECK (review_type = 'workflow'),
  decision TEXT NOT NULL CHECK (decision IN ('changes_requested','accepted')),
  feedback TEXT NOT NULL CHECK (length(feedback) BETWEEN 1 AND 6000),
  requested_changes_json TEXT NOT NULL DEFAULT '[]' CHECK (length(requested_changes_json) <= 12000),
  model_invocation_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (artifact_id) REFERENCES internship_artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES internship_artifact_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (internship_id, task_id) REFERENCES internship_tasks(internship_id, task_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_artifact_activity (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  artifact_id TEXT NOT NULL DEFAULT '',
  version_id TEXT NOT NULL DEFAULT '',
  submission_id TEXT NOT NULL DEFAULT '',
  review_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'assignment_acknowledged',
      'draft_created',
      'artifact_version_saved',
      'artifact_submitted',
      'artifact_resubmitted',
      'changes_requested',
      'artifact_accepted',
      'task_completed'
    )
  ),
  event_time INTEGER NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  detail_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (internship_id, event_type, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_internship_artifacts_task
  ON internship_artifacts(internship_id, task_id, status, deliverable_type);
CREATE INDEX IF NOT EXISTS idx_internship_artifact_versions_history
  ON internship_artifact_versions(artifact_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_internship_artifact_versions_recent
  ON internship_artifact_versions(internship_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_internship_artifact_submissions_history
  ON internship_artifact_submissions(artifact_id, submission_number DESC);
CREATE INDEX IF NOT EXISTS idx_internship_artifact_submissions_status
  ON internship_artifact_submissions(internship_id, status, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_artifact_one_active_submission
  ON internship_artifact_submissions(artifact_id)
  WHERE status IN ('submitted','under_review');
CREATE INDEX IF NOT EXISTS idx_internship_artifact_reviews_task
  ON internship_artifact_reviews(internship_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internship_artifact_activity_time
  ON internship_artifact_activity(internship_id, event_time DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internship_artifact_task_completed_once
  ON internship_artifact_activity(internship_id, task_id, event_type)
  WHERE event_type = 'task_completed';

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_versions_no_update
BEFORE UPDATE ON internship_artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'artifact_version_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_versions_no_delete
BEFORE DELETE ON internship_artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'artifact_version_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_submissions_pin_immutable
BEFORE UPDATE OF artifact_id, artifact_version_id, internship_id, task_id, submission_number,
  prior_submission_id, request_id, submitted_at
ON internship_artifact_submissions
BEGIN
  SELECT RAISE(ABORT, 'artifact_submission_pin_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_submissions_no_delete
BEFORE DELETE ON internship_artifact_submissions
BEGIN
  SELECT RAISE(ABORT, 'artifact_submission_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_reviews_no_update
BEFORE UPDATE ON internship_artifact_reviews
BEGIN
  SELECT RAISE(ABORT, 'artifact_review_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_reviews_no_delete
BEFORE DELETE ON internship_artifact_reviews
BEGIN
  SELECT RAISE(ABORT, 'artifact_review_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_activity_no_update
BEFORE UPDATE ON internship_artifact_activity
BEGIN
  SELECT RAISE(ABORT, 'artifact_activity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_artifact_activity_no_delete
BEFORE DELETE ON internship_artifact_activity
BEGIN
  SELECT RAISE(ABORT, 'artifact_activity_immutable');
END;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase5_artifact_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
