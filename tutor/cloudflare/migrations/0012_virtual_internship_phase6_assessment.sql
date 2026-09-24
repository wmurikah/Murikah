PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 6: immutable formal assessment lineage, assistance
-- provenance and auditable midpoint/final performance reviews.
CREATE TABLE IF NOT EXISTS internship_assessments (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  rubric_id TEXT NOT NULL CHECK (length(rubric_id) BETWEEN 1 AND 128),
  rubric_schema_version INTEGER NOT NULL CHECK (rubric_schema_version > 0),
  rubric_hash TEXT NOT NULL CHECK (length(rubric_hash) = 64),
  assessment_type TEXT NOT NULL DEFAULT 'artifact' CHECK (assessment_type = 'artifact'),
  status TEXT NOT NULL CHECK (status IN ('pending','assessing','completed','failed')),
  assessor_model_invocation_id TEXT NOT NULL DEFAULT '',
  assessor_prompt_version INTEGER NOT NULL DEFAULT 1 CHECK (assessor_prompt_version > 0),
  assessor_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (assessor_schema_version > 0),
  calculation_version TEXT NOT NULL CHECK (length(calculation_version) BETWEEN 1 AND 80),
  aggregate_numeric TEXT,
  overall_summary TEXT NOT NULL DEFAULT '' CHECK (length(overall_summary) <= 4000),
  limitations_json TEXT NOT NULL DEFAULT '[]' CHECK (length(limitations_json) <= 16000),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  failed_at INTEGER,
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id, task_id) REFERENCES internship_tasks(internship_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id) REFERENCES internship_artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_version_id) REFERENCES internship_artifact_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES internship_artifact_submissions(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_assessment_criteria (
  assessment_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL CHECK (length(criterion_id) BETWEEN 1 AND 128),
  result_state TEXT NOT NULL CHECK (result_state IN ('assessed','not_assessed')),
  rating_id TEXT NOT NULL DEFAULT '' CHECK (length(rating_id) <= 80),
  numeric_value TEXT,
  feedback TEXT NOT NULL DEFAULT '' CHECK (length(feedback) <= 3000),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (length(evidence_refs_json) <= 32000),
  limitation TEXT NOT NULL DEFAULT '' CHECK (length(limitation) <= 2000),
  PRIMARY KEY (assessment_id, criterion_id),
  FOREIGN KEY (assessment_id) REFERENCES internship_assessments(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_assistance_events (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  artifact_id TEXT NOT NULL DEFAULT '',
  artifact_version_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('murikah_mentor','external_declared','approved_tool')),
  provenance TEXT NOT NULL CHECK (provenance IN ('system_observed','learner_declared')),
  assistance_level INTEGER NOT NULL CHECK (assistance_level BETWEEN 0 AND 5),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  model_invocation_id TEXT NOT NULL DEFAULT '',
  event_time INTEGER NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  UNIQUE (internship_id, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS internship_performance_reviews (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  review_type TEXT NOT NULL CHECK (review_type IN ('midpoint','final')),
  cutoff_at INTEGER NOT NULL,
  evidence_snapshot_json TEXT NOT NULL CHECK (length(evidence_snapshot_json) <= 100000),
  evidence_snapshot_hash TEXT NOT NULL CHECK (length(evidence_snapshot_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('finalized','superseded')),
  strengths_json TEXT NOT NULL DEFAULT '[]' CHECK (length(strengths_json) <= 24000),
  development_areas_json TEXT NOT NULL DEFAULT '[]' CHECK (length(development_areas_json) <= 24000),
  priorities_json TEXT NOT NULL DEFAULT '[]' CHECK (length(priorities_json) <= 24000),
  assistance_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (length(assistance_summary_json) <= 12000),
  narrative TEXT NOT NULL DEFAULT '' CHECK (length(narrative) <= 8000),
  model_invocation_id TEXT NOT NULL DEFAULT '',
  narrative_version INTEGER NOT NULL DEFAULT 1 CHECK (narrative_version > 0),
  supersedes_review_id TEXT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  finalized_at INTEGER NOT NULL,
  UNIQUE (internship_id, review_type, request_id),
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_review_id) REFERENCES internship_performance_reviews(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_internship_assessments_submission
  ON internship_assessments(internship_id, submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internship_assessments_task
  ON internship_assessments(internship_id, task_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internship_assessment_criteria_assessment
  ON internship_assessment_criteria(assessment_id, criterion_id);
CREATE INDEX IF NOT EXISTS idx_internship_assistance_time
  ON internship_assistance_events(internship_id, event_time ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_internship_assistance_task
  ON internship_assistance_events(internship_id, task_id, event_time ASC);
CREATE INDEX IF NOT EXISTS idx_internship_performance_reviews_type
  ON internship_performance_reviews(internship_id, review_type, finalized_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_internship_assessments_completed_immutable
BEFORE UPDATE ON internship_assessments
WHEN OLD.status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'assessment_completed_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_assessments_no_delete
BEFORE DELETE ON internship_assessments
BEGIN
  SELECT RAISE(ABORT, 'assessment_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_assessment_criteria_no_update
BEFORE UPDATE ON internship_assessment_criteria
BEGIN
  SELECT RAISE(ABORT, 'assessment_criterion_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_assessment_criteria_no_delete
BEFORE DELETE ON internship_assessment_criteria
BEGIN
  SELECT RAISE(ABORT, 'assessment_criterion_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_assistance_no_update
BEFORE UPDATE ON internship_assistance_events
BEGIN
  SELECT RAISE(ABORT, 'assistance_event_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_assistance_no_delete
BEFORE DELETE ON internship_assistance_events
BEGIN
  SELECT RAISE(ABORT, 'assistance_event_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_performance_reviews_finalized_immutable
BEFORE UPDATE ON internship_performance_reviews
WHEN OLD.status = 'finalized'
BEGIN
  SELECT RAISE(ABORT, 'performance_review_finalized_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_internship_performance_reviews_no_delete
BEFORE DELETE ON internship_performance_reviews
BEGIN
  SELECT RAISE(ABORT, 'performance_review_immutable');
END;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase6_assessment_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
