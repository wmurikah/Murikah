PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 7: versioned competency definitions, immutable
-- competency evidence and rebuildable learner-owned Competency Passport summaries.
CREATE TABLE IF NOT EXISTS competency_level_frameworks (
  version TEXT PRIMARY KEY,
  levels_json TEXT NOT NULL CHECK (length(levels_json) BETWEEN 2 AND 16000),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS competency_definitions (
  competency_id TEXT NOT NULL CHECK (length(competency_id) BETWEEN 1 AND 128),
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 128),
  parent_competency_id TEXT,
  level_framework_version TEXT NOT NULL CHECK (length(level_framework_version) BETWEEN 1 AND 80),
  evidence_requirements_json TEXT NOT NULL CHECK (length(evidence_requirements_json) BETWEEN 2 AND 32000),
  transfer_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (length(transfer_policy_json) <= 16000),
  recency_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (length(recency_policy_json) <= 16000),
  context_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (length(context_metadata_json) <= 16000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (competency_id, definition_version),
  FOREIGN KEY (level_framework_version) REFERENCES competency_level_frameworks(version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_assessment_mappings (
  mapping_version INTEGER NOT NULL CHECK (mapping_version > 0),
  scenario_version_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  rubric_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  competency_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  sub_competency_id TEXT NOT NULL DEFAULT '',
  context_tags_json TEXT NOT NULL DEFAULT '{}' CHECK (length(context_tags_json) <= 16000),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mapping_version, scenario_version_id, task_id, rubric_id, criterion_id, competency_id),
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (competency_id, definition_version) REFERENCES competency_definitions(competency_id, definition_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_definition_compatibility (
  competency_id TEXT NOT NULL,
  from_version INTEGER NOT NULL CHECK (from_version > 0),
  to_version INTEGER NOT NULL CHECK (to_version > 0),
  compatibility TEXT NOT NULL CHECK (compatibility IN ('compatible','incompatible')),
  rationale TEXT NOT NULL DEFAULT '' CHECK (length(rationale) <= 1000),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (competency_id, from_version, to_version),
  FOREIGN KEY (competency_id, from_version) REFERENCES competency_definitions(competency_id, definition_version) ON DELETE RESTRICT,
  FOREIGN KEY (competency_id, to_version) REFERENCES competency_definitions(competency_id, definition_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_evidence (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  competency_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  sub_competency_id TEXT NOT NULL DEFAULT '',
  internship_id TEXT NOT NULL,
  scenario_pack_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  mapping_version INTEGER NOT NULL CHECK (mapping_version > 0),
  criterion_rating_id TEXT NOT NULL,
  criterion_numeric TEXT,
  demonstrated_level TEXT NOT NULL CHECK (demonstrated_level IN ('not_demonstrated','developing','applied_with_support','independent')),
  assistance_level INTEGER NOT NULL CHECK (assistance_level BETWEEN 0 AND 5),
  assistance_context_json TEXT NOT NULL DEFAULT '{}' CHECK (length(assistance_context_json) <= 16000),
  revision_context_json TEXT NOT NULL DEFAULT '{}' CHECK (length(revision_context_json) <= 16000),
  evidence_strength TEXT NOT NULL CHECK (evidence_strength IN ('limited','supporting','strong')),
  strength_factors_json TEXT NOT NULL DEFAULT '{}' CHECK (length(strength_factors_json) <= 16000),
  transfer_context_json TEXT NOT NULL DEFAULT '{}' CHECK (length(transfer_context_json) <= 16000),
  limitations_json TEXT NOT NULL DEFAULT '[]' CHECK (length(limitations_json) <= 16000),
  source_type TEXT NOT NULL DEFAULT 'virtual_internship' CHECK (source_type IN ('virtual_internship','mastery_path','project','oral_viva','instructor_assessment','external_portfolio')),
  evidence_ruleset_version TEXT NOT NULL CHECK (length(evidence_ruleset_version) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  UNIQUE (learner_id, assessment_id, criterion_id, competency_id, definition_version, mapping_version, evidence_ruleset_version),
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (internship_id) REFERENCES internship_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id) REFERENCES internship_artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_version_id) REFERENCES internship_artifact_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES internship_artifact_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (assessment_id) REFERENCES internship_assessments(id) ON DELETE RESTRICT,
  FOREIGN KEY (assessment_id, criterion_id) REFERENCES internship_assessment_criteria(assessment_id, criterion_id) ON DELETE RESTRICT,
  FOREIGN KEY (competency_id, definition_version) REFERENCES competency_definitions(competency_id, definition_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_evidence_adjustments (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('revoked','superseded')),
  replacement_evidence_id TEXT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  admin_actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 3 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE (admin_actor_id, request_id),
  FOREIGN KEY (evidence_id) REFERENCES competency_evidence(id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_evidence_id) REFERENCES competency_evidence(id) ON DELETE RESTRICT,
  FOREIGN KEY (admin_actor_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_passports (
  learner_id TEXT NOT NULL,
  competency_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  current_level TEXT NOT NULL CHECK (current_level IN ('emerging','developing','applied_with_support','independent','advanced')),
  evidence_strength_summary TEXT NOT NULL CHECK (evidence_strength_summary IN ('limited','supporting','strong')),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  independent_count INTEGER NOT NULL CHECK (independent_count >= 0),
  assisted_count INTEGER NOT NULL CHECK (assisted_count >= 0),
  distinct_task_count INTEGER NOT NULL CHECK (distinct_task_count >= 0),
  distinct_context_count INTEGER NOT NULL CHECK (distinct_context_count >= 0),
  distinct_internship_count INTEGER NOT NULL CHECK (distinct_internship_count >= 0),
  trend TEXT NOT NULL CHECK (trend IN ('improving','stable','mixed','insufficient_evidence')),
  last_demonstrated_at INTEGER NOT NULL,
  explanation_json TEXT NOT NULL DEFAULT '{}' CHECK (length(explanation_json) <= 16000),
  next_requirements_json TEXT NOT NULL DEFAULT '[]' CHECK (length(next_requirements_json) <= 16000),
  aggregation_ruleset_version TEXT NOT NULL CHECK (length(aggregation_ruleset_version) BETWEEN 1 AND 80),
  calculated_at INTEGER NOT NULL,
  PRIMARY KEY (learner_id, competency_id, definition_version),
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (competency_id, definition_version) REFERENCES competency_definitions(competency_id, definition_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_passport_history (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  competency_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  previous_level TEXT,
  new_level TEXT CHECK (new_level IS NULL OR new_level IN ('emerging','developing','applied_with_support','independent','advanced')),
  aggregation_ruleset_version TEXT NOT NULL,
  explanation_json TEXT NOT NULL DEFAULT '{}',
  changed_at INTEGER NOT NULL,
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (competency_id, definition_version) REFERENCES competency_definitions(competency_id, definition_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS competency_derivation_status (
  assessment_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','excluded','failed')),
  evidence_ruleset_version TEXT NOT NULL,
  mapping_version INTEGER NOT NULL DEFAULT 0 CHECK (mapping_version >= 0),
  derived_count INTEGER NOT NULL DEFAULT 0 CHECK (derived_count >= 0),
  last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 1000),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (assessment_id) REFERENCES internship_assessments(id) ON DELETE RESTRICT,
  FOREIGN KEY (learner_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_competency_evidence_learner_competency
  ON competency_evidence(learner_id, competency_id, definition_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_competency_evidence_competency_date
  ON competency_evidence(competency_id, definition_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_competency_evidence_internship
  ON competency_evidence(internship_id, competency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_competency_evidence_assessment
  ON competency_evidence(assessment_id, criterion_id);
CREATE INDEX IF NOT EXISTS idx_competency_evidence_lineage
  ON competency_evidence(artifact_id, artifact_version_id, submission_id);
CREATE INDEX IF NOT EXISTS idx_competency_adjustments_evidence
  ON competency_evidence_adjustments(evidence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_competency_passports_learner
  ON competency_passports(learner_id, current_level, competency_id);
CREATE INDEX IF NOT EXISTS idx_competency_history_learner_competency
  ON competency_passport_history(learner_id, competency_id, definition_version, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_competency_derivation_learner_status
  ON competency_derivation_status(learner_id, status, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_competency_level_frameworks_no_update
BEFORE UPDATE ON competency_level_frameworks BEGIN SELECT RAISE(ABORT, 'competency_level_framework_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_level_frameworks_no_delete
BEFORE DELETE ON competency_level_frameworks BEGIN SELECT RAISE(ABORT, 'competency_level_framework_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_definitions_no_update
BEFORE UPDATE ON competency_definitions BEGIN SELECT RAISE(ABORT, 'competency_definition_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_definitions_no_delete
BEFORE DELETE ON competency_definitions BEGIN SELECT RAISE(ABORT, 'competency_definition_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_mappings_no_update
BEFORE UPDATE ON competency_assessment_mappings BEGIN SELECT RAISE(ABORT, 'competency_mapping_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_mappings_no_delete
BEFORE DELETE ON competency_assessment_mappings BEGIN SELECT RAISE(ABORT, 'competency_mapping_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_compatibility_no_update
BEFORE UPDATE ON competency_definition_compatibility BEGIN SELECT RAISE(ABORT, 'competency_compatibility_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_compatibility_no_delete
BEFORE DELETE ON competency_definition_compatibility BEGIN SELECT RAISE(ABORT, 'competency_compatibility_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_evidence_no_update
BEFORE UPDATE ON competency_evidence BEGIN SELECT RAISE(ABORT, 'competency_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_evidence_no_delete
BEFORE DELETE ON competency_evidence BEGIN SELECT RAISE(ABORT, 'competency_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_adjustments_no_update
BEFORE UPDATE ON competency_evidence_adjustments BEGIN SELECT RAISE(ABORT, 'competency_evidence_adjustment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_adjustments_no_delete
BEFORE DELETE ON competency_evidence_adjustments BEGIN SELECT RAISE(ABORT, 'competency_evidence_adjustment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_history_no_update
BEFORE UPDATE ON competency_passport_history BEGIN SELECT RAISE(ABORT, 'competency_passport_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_competency_history_no_delete
BEFORE DELETE ON competency_passport_history BEGIN SELECT RAISE(ABORT, 'competency_passport_history_immutable'); END;

-- One persisted display authority for the canonical ordered level framework.
INSERT OR IGNORE INTO competency_level_frameworks(version,levels_json,created_at) VALUES (
  'phase7-levels-v1',
  '[{"id":"emerging","label":"Emerging","meaning":"Early demonstrated evidence exists; task exposure alone is not evidence."},{"id":"developing","label":"Developing","meaning":"Repeated partial or improving demonstration is supported by evidence."},{"id":"applied_with_support","label":"Applied with support","meaning":"Credible application is demonstrated with material assistance in context."},{"id":"independent","label":"Independent","meaning":"Successful performance includes qualifying low-assistance evidence."},{"id":"advanced","label":"Advanced","meaning":"Repeated independent performance is demonstrated across sufficiently distinct contexts."}]',
  unixepoch()
);

-- The canonical Phase 7 level framework is shared but each definition persists
-- its own authored deterministic requirements so future competencies can differ.
INSERT OR IGNORE INTO competency_definitions(
  competency_id, definition_version, name, description, domain, parent_competency_id,
  level_framework_version, evidence_requirements_json, transfer_policy_json,
  recency_policy_json, context_metadata_json, status, created_at
) VALUES
('comp_process_understanding',1,'Process understanding','Understands a work process, its relevant steps and control points.','internal_audit',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_reconciliation',1,'Reconciliation','Reconciles records systematically and identifies supported discrepancies.','internal_audit',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_investigation',1,'Investigation','Investigates an issue using supplied evidence while separating facts from assumptions.','internal_audit',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_written_communication',1,'Written communication','Communicates professional work clearly with traceable evidence and appropriate uncertainty.','internal_audit',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_data_understanding',1,'Data understanding','Identifies data grain, fields, constraints and relevant analytical assumptions.','data_analysis',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_metric_definition',1,'Metric definition','Defines analytical measures with clear logic, scope and assumptions.','data_analysis',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_data_quality',1,'Data quality','Plans evidence-based checks for data completeness, validity and reliability.','data_analysis',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_issue_triage',1,'Issue triage','Frames a software issue from available evidence and identifies the next diagnostic steps.','software_engineering',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_debugging',1,'Debugging','Reproduces and investigates software behavior using traceable technical evidence.','software_engineering',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_change_planning',1,'Change planning','Plans a software change with clear scope, risks and implementation considerations.','software_engineering',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch()),
('comp_test_reasoning',1,'Test reasoning','Uses evidence to identify meaningful software test requirements and expected behavior.','software_engineering',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}', 'active', unixepoch());

-- Explicitly authored criterion-to-competency mappings for the published v2
-- rubric-enabled demo versions. No mapping is inferred from assessor prose.
INSERT OR IGNORE INTO competency_assessment_mappings(
  mapping_version,scenario_version_id,task_id,rubric_id,criterion_id,competency_id,
  definition_version,sub_competency_id,context_tags_json,created_at
)
SELECT 1, x.scenario_version_id, x.task_id, x.rubric_id, c.criterion_id, x.competency_id, 1, '',
       x.context_tags_json, unixepoch()
FROM (
  SELECT 'sv_demo_internal_audit_v2' scenario_version_id,'task_review_process' task_id,'rubric_task_review_process_v1' rubric_id,'comp_process_understanding' competency_id,'{"career_family":"internal_audit","role_family":"internal_audit","scenario_pack_id":"sp_demo_internal_audit","task_category":"review","domain":"internal_audit","work_context":"process_review"}' context_tags_json
  UNION ALL SELECT 'sv_demo_internal_audit_v2','task_reconcile_sample','rubric_task_reconcile_sample_v1','comp_reconciliation','{"career_family":"internal_audit","role_family":"internal_audit","scenario_pack_id":"sp_demo_internal_audit","task_category":"analytical","domain":"internal_audit","work_context":"reconciliation"}'
  UNION ALL SELECT 'sv_demo_internal_audit_v2','task_investigate_variance','rubric_task_investigate_variance_v1','comp_investigation','{"career_family":"internal_audit","role_family":"internal_audit","scenario_pack_id":"sp_demo_internal_audit","task_category":"investigative","domain":"internal_audit","work_context":"variance_investigation"}'
  UNION ALL SELECT 'sv_demo_internal_audit_v2','task_draft_issue','rubric_task_draft_issue_v1','comp_written_communication','{"career_family":"internal_audit","role_family":"internal_audit","scenario_pack_id":"sp_demo_internal_audit","task_category":"communication","domain":"internal_audit","work_context":"issue_communication"}'
  UNION ALL SELECT 'sv_demo_data_analyst_v2','task_inspect_dataset','rubric_task_inspect_dataset_v1','comp_data_understanding','{"career_family":"data_analysis","role_family":"data_analysis","scenario_pack_id":"sp_demo_data_analyst","task_category":"analytical","domain":"data_analysis","work_context":"dataset_review"}'
  UNION ALL SELECT 'sv_demo_data_analyst_v2','task_define_metric','rubric_task_define_metric_v1','comp_metric_definition','{"career_family":"data_analysis","role_family":"data_analysis","scenario_pack_id":"sp_demo_data_analyst","task_category":"analytical","domain":"data_analysis","work_context":"metric_definition"}'
  UNION ALL SELECT 'sv_demo_data_analyst_v2','task_quality_plan','rubric_task_quality_plan_v1','comp_data_quality','{"career_family":"data_analysis","role_family":"data_analysis","scenario_pack_id":"sp_demo_data_analyst","task_category":"planning","domain":"data_analysis","work_context":"data_quality"}'
  UNION ALL SELECT 'sv_demo_software_engineering_v2','task_understand_issue','rubric_task_understand_issue_v1','comp_issue_triage','{"career_family":"software_engineering","role_family":"software_engineering","scenario_pack_id":"sp_demo_software_engineering","task_category":"review","domain":"software_engineering","work_context":"issue_triage"}'
  UNION ALL SELECT 'sv_demo_software_engineering_v2','task_reproduce_bug','rubric_task_reproduce_bug_v1','comp_debugging','{"career_family":"software_engineering","role_family":"software_engineering","scenario_pack_id":"sp_demo_software_engineering","task_category":"investigative","domain":"software_engineering","work_context":"bug_reproduction"}'
  UNION ALL SELECT 'sv_demo_software_engineering_v2','task_fix_plan','rubric_task_fix_plan_v1','comp_change_planning','{"career_family":"software_engineering","role_family":"software_engineering","scenario_pack_id":"sp_demo_software_engineering","task_category":"planning","domain":"software_engineering","work_context":"change_planning"}'
  UNION ALL SELECT 'sv_demo_software_engineering_v2','task_review_test_requirement','rubric_task_review_test_requirement_v1','comp_test_reasoning','{"career_family":"software_engineering","role_family":"software_engineering","scenario_pack_id":"sp_demo_software_engineering","task_category":"review","domain":"software_engineering","work_context":"test_reasoning"}'
) x
CROSS JOIN (
  SELECT 'task_requirements' criterion_id
  UNION ALL SELECT 'evidence_reasoning'
  UNION ALL SELECT 'deliverable_clarity'
) c;

INSERT OR IGNORE INTO competency_definition_compatibility(
  competency_id,from_version,to_version,compatibility,rationale,created_at
)
SELECT competency_id,1,1,'compatible','Same immutable definition version.',unixepoch()
FROM competency_definitions WHERE definition_version=1;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('virtual_internship_phase7_passport_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
