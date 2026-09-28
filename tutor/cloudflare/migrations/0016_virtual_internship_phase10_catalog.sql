PRAGMA foreign_keys = ON;

-- Virtual Internship Phase 10: career catalog, published catalog projection,
-- versioned scenario templates and trusted institution scenario workflow.

CREATE TABLE IF NOT EXISTS career_families (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  short_title TEXT NOT NULL,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  physical_competency_classification TEXT NOT NULL CHECK (physical_competency_classification IN ('knowledge_work','mixed','physical_skill_limited')),
  physical_competency_limitation_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS internship_catalog_entries (
  id TEXT PRIMARY KEY,
  scenario_pack_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL UNIQUE,
  catalog_slug TEXT NOT NULL,
  career_family_id TEXT NOT NULL,
  title TEXT NOT NULL,
  role_title TEXT NOT NULL,
  simulated_company_name TEXT NOT NULL,
  sector TEXT NOT NULL,
  region TEXT NOT NULL,
  short_description TEXT NOT NULL,
  long_description TEXT NOT NULL,
  internship_type TEXT NOT NULL CHECK (internship_type IN ('qualifying','practice')),
  qualifying INTEGER NOT NULL CHECK (qualifying IN (0,1)),
  mode TEXT NOT NULL CHECK (mode IN ('standard','demo')),
  minimum_duration_days INTEGER NOT NULL CHECK (minimum_duration_days > 0),
  weekly_hours_min INTEGER NOT NULL CHECK (weekly_hours_min > 0),
  weekly_hours_max INTEGER NOT NULL CHECK (weekly_hours_max >= weekly_hours_min),
  workload_band TEXT NOT NULL CHECK (workload_band IN ('light','standard','intensive')),
  experience_level TEXT NOT NULL CHECK (experience_level IN ('entry','early_career','intermediate')),
  competencies_json TEXT NOT NULL,
  responsibilities_json TEXT NOT NULL,
  deliverables_json TEXT NOT NULL,
  work_rhythm TEXT NOT NULL,
  prerequisites TEXT NOT NULL DEFAULT '',
  physical_competency_classification TEXT NOT NULL CHECK (physical_competency_classification IN ('knowledge_work','mixed','physical_skill_limited')),
  physical_competency_limitation_text TEXT NOT NULL DEFAULT '',
  simulation_disclosure TEXT NOT NULL,
  completion_overview TEXT NOT NULL,
  support_summary TEXT NOT NULL,
  search_keywords_json TEXT NOT NULL DEFAULT '[]',
  searchable_text TEXT NOT NULL,
  metadata_hash TEXT NOT NULL CHECK (length(metadata_hash)=64),
  sort_order INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  catalog_state TEXT NOT NULL CHECK (catalog_state IN ('published','retired')),
  visible INTEGER NOT NULL CHECK (visible IN (0,1)),
  retired_at INTEGER,
  FOREIGN KEY (scenario_pack_id) REFERENCES scenario_packs(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (career_family_id) REFERENCES career_families(id) ON DELETE RESTRICT,
  CHECK ((qualifying=1 AND internship_type='qualifying' AND mode='standard' AND minimum_duration_days>=90) OR
         (qualifying=0 AND internship_type='practice' AND mode='demo'))
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published','retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scenario_template_versions (
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  status TEXT NOT NULL CHECK (status IN ('published','retired')),
  content_hash TEXT NOT NULL CHECK (length(content_hash)=64),
  source_path TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY(template_id, template_version),
  FOREIGN KEY (template_id) REFERENCES scenario_templates(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS institution_scenario_drafts (
  id TEXT PRIMARY KEY,
  created_by_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','validation_failed','validated','published','retired')),
  draft_json TEXT NOT NULL CHECK (length(draft_json) BETWEEN 2 AND 900000),
  validation_json TEXT NOT NULL DEFAULT '{}',
  resolved_content_hash TEXT NOT NULL DEFAULT '',
  scenario_pack_id TEXT NOT NULL DEFAULT '',
  scenario_version_id TEXT NOT NULL DEFAULT '',
  catalog_slug TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  retired_at INTEGER,
  FOREIGN KEY (created_by_actor_id) REFERENCES tutor_accounts(actor_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_career_families_active_sort ON career_families(active, sort_order, slug);
CREATE INDEX IF NOT EXISTS idx_catalog_visible_type_sort ON internship_catalog_entries(catalog_state, visible, internship_type, sort_order);
CREATE INDEX IF NOT EXISTS idx_catalog_family ON internship_catalog_entries(career_family_id, catalog_state, visible, sort_order);
CREATE INDEX IF NOT EXISTS idx_catalog_sector ON internship_catalog_entries(sector, catalog_state, visible);
CREATE INDEX IF NOT EXISTS idx_catalog_workload ON internship_catalog_entries(workload_band, catalog_state, visible);
CREATE INDEX IF NOT EXISTS idx_catalog_experience ON internship_catalog_entries(experience_level, catalog_state, visible);
CREATE INDEX IF NOT EXISTS idx_catalog_scenario_version ON internship_catalog_entries(scenario_version_id);
CREATE INDEX IF NOT EXISTS idx_catalog_slug ON internship_catalog_entries(catalog_slug, catalog_state, visible);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_one_current_slug ON internship_catalog_entries(catalog_slug)
  WHERE catalog_state='published' AND visible=1;
CREATE INDEX IF NOT EXISTS idx_template_versions_status ON scenario_template_versions(status, template_id, template_version DESC);
CREATE INDEX IF NOT EXISTS idx_institution_scenario_owner_status ON institution_scenario_drafts(created_by_actor_id, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_published_institution_draft_immutable
BEFORE UPDATE ON institution_scenario_drafts
WHEN OLD.status='published' AND (
  NEW.draft_json<>OLD.draft_json OR
  NEW.validation_json<>OLD.validation_json OR
  NEW.resolved_content_hash<>OLD.resolved_content_hash OR
  NEW.scenario_pack_id<>OLD.scenario_pack_id OR
  NEW.scenario_version_id<>OLD.scenario_version_id OR
  NEW.catalog_slug<>OLD.catalog_slug
)
BEGIN
  SELECT RAISE(ABORT,'published institution scenario is immutable');
END;

INSERT OR IGNORE INTO career_families(
  id,schema_version,slug,title,short_title,description,sort_order,active,
  physical_competency_classification,physical_competency_limitation_text,created_at,updated_at
) VALUES
('cf_audit_assurance_v1',1,'audit_assurance','Audit and Assurance','Audit','Professional assurance, risk, controls, evidence and reporting work.',10,1,'knowledge_work','',unixepoch(),unixepoch()),
('cf_data_analytics_v1',1,'data_analytics','Data Analytics','Data','Data quality, metrics, analysis, interpretation and stakeholder communication.',20,1,'knowledge_work','',unixepoch(),unixepoch()),
('cf_software_engineering_v1',1,'software_engineering','Software Engineering','Software','Software problem solving, design, testing, debugging, review and documentation.',30,1,'knowledge_work','',unixepoch(),unixepoch()),
('cf_cybersecurity_v1',1,'cybersecurity','Cybersecurity','Cybersecurity','Defensive security analysis, control assessment, risk triage and remediation planning.',40,1,'knowledge_work','',unixepoch(),unixepoch()),
('cf_finance_v1',1,'finance','Finance','Finance','Financial analysis, budgeting, forecasting, reconciliation and management reporting.',50,1,'knowledge_work','',unixepoch(),unixepoch()),
('cf_project_operations_v1',1,'project_operations','Project and Operations Management','Projects','Project planning, stakeholder coordination, risk, change and delivery management.',60,1,'knowledge_work','',unixepoch(),unixepoch());

INSERT OR IGNORE INTO scenario_templates(id,title,status,created_at,updated_at) VALUES
('tpl_standard_90_day_knowledge_work','standard 90 day knowledge work','published',unixepoch(),unixepoch()),
('tpl_common_workplace_communication','common workplace communication','published',unixepoch(),unixepoch()),
('tpl_standard_midpoint_review','standard midpoint review','published',unixepoch(),unixepoch()),
('tpl_standard_final_review','standard final review','published',unixepoch(),unixepoch()),
('tpl_standard_completion_disclosure','standard completion disclosure','published',unixepoch(),unixepoch()),
('tpl_shared_ethics_event_patterns','shared ethics event patterns','published',unixepoch(),unixepoch());

INSERT OR IGNORE INTO scenario_template_versions(
  template_id,template_version,schema_version,status,content_hash,source_path,published_at,retired_at
) VALUES
('tpl_standard_90_day_knowledge_work',1,1,'published','1a5fc3894bbb61fb9a4b00bc23ea41ecac7146334ff7c53be872853e4dfb29fc','virtual-internship/templates/v1/standard-90-day-knowledge-work-v1.json',unixepoch(),unixepoch()),
('tpl_common_workplace_communication',1,1,'published','88e73f6c143ad019f3afef6a658ef29060394defc5e5d614f0fb0a8fda25e821','virtual-internship/templates/v1/common-workplace-communication-v1.json',unixepoch(),unixepoch()),
('tpl_standard_midpoint_review',1,1,'published','9b47bcfa3d04cfeed7b770d192774a4c9bc83beacb5e2c2a5fa45466e39a2587','virtual-internship/templates/v1/standard-midpoint-review-v1.json',unixepoch(),unixepoch()),
('tpl_standard_final_review',1,1,'published','85ded058d84ac0ceae69b761fc2d968722e6a190949530a064e67fa49286cb41','virtual-internship/templates/v1/standard-final-review-v1.json',unixepoch(),unixepoch()),
('tpl_standard_completion_disclosure',1,1,'published','667ef818309ed5843b79374d2bed35c6c878caa768f99e14522fac842ea7b665','virtual-internship/templates/v1/standard-completion-disclosure-v1.json',unixepoch(),unixepoch()),
('tpl_shared_ethics_event_patterns',1,1,'published','c61cba3860923f0d52ccfce5b83dd7a5606aec8a544c6b8fcc0c1de11777f535','virtual-internship/templates/v1/shared-ethics-event-patterns-v1.json',unixepoch(),unixepoch());

INSERT OR IGNORE INTO scenario_packs(
  id,slug,title,career_family,role_title,status,created_at,updated_at
) VALUES
('sp_internal_audit_qualifying','internal-audit-internship','Internal Audit Virtual Internship','audit_assurance','Internal Audit Intern','published',unixepoch(),unixepoch()),
('sp_data_analyst_qualifying','data-analyst-internship','Data Analyst Virtual Internship','data_analytics','Data Analyst Intern','published',unixepoch(),unixepoch()),
('sp_software_engineering_qualifying','software-engineering-internship','Software Engineering Virtual Internship','software_engineering','Software Engineering Intern','published',unixepoch(),unixepoch()),
('sp_cybersecurity_analyst_qualifying','cybersecurity-analyst-internship','Cybersecurity Analyst Virtual Internship','cybersecurity','Cybersecurity Analyst Intern','published',unixepoch(),unixepoch()),
('sp_financial_analyst_qualifying','financial-analyst-internship','Financial Analyst Virtual Internship','finance','Financial Analyst Intern','published',unixepoch(),unixepoch()),
('sp_project_management_qualifying','project-management-internship','Project Management Virtual Internship','project_operations','Project Management Intern','published',unixepoch(),unixepoch());

INSERT OR IGNORE INTO scenario_versions(
  id,scenario_pack_id,version,schema_version,status,manifest_ref,minimum_duration_days,
  expected_workload_band,content_hash,created_at,published_at
) VALUES
('sv_internal_audit_qualifying_v1','sp_internal_audit_qualifying',1,1,'published','d1:scenario-version-content/sv_internal_audit_qualifying_v1',90,'standard','62f148de3fd2b9a902a4ed61bb6d803fafdb7479b7410ad666160d81dbdbec68',unixepoch(),unixepoch()),
('sv_data_analyst_qualifying_v1','sp_data_analyst_qualifying',1,1,'published','d1:scenario-version-content/sv_data_analyst_qualifying_v1',90,'standard','42c05894272758c78f50ba071a912f7f4e3ca5d8b97cfd7fcd5f3d55a78c306b',unixepoch(),unixepoch()),
('sv_software_engineering_qualifying_v1','sp_software_engineering_qualifying',1,1,'published','d1:scenario-version-content/sv_software_engineering_qualifying_v1',90,'standard','3e2fa06a5e552e88a5c0eeda2deec87491f0a9cba0c30f875b3a7870160faf1c',unixepoch(),unixepoch()),
('sv_cybersecurity_analyst_qualifying_v1','sp_cybersecurity_analyst_qualifying',1,1,'published','d1:scenario-version-content/sv_cybersecurity_analyst_qualifying_v1',90,'standard','8d6c68c15eebab43270c28a61f5305469c8ef98cea47c1d49f0b49f710ed7506',unixepoch(),unixepoch()),
('sv_financial_analyst_qualifying_v1','sp_financial_analyst_qualifying',1,1,'published','d1:scenario-version-content/sv_financial_analyst_qualifying_v1',90,'standard','8eb809382e4deb13eb57f7c9f1ae661128be371829f51b5e1ace2310328ea07a',unixepoch(),unixepoch()),
('sv_project_management_qualifying_v1','sp_project_management_qualifying',1,1,'published','d1:scenario-version-content/sv_project_management_qualifying_v1',90,'standard','69be458aa6644d106e3754ab3da13482449014d158de3a5002faef9fe08e45dd',unixepoch(),unixepoch());

-- Preserve existing demo pack IDs and slugs. Phase 10 adds new non-qualifying
-- catalog-visible versions without changing any historical demo version.
INSERT OR IGNORE INTO scenario_versions(
  id,scenario_pack_id,version,schema_version,status,manifest_ref,minimum_duration_days,
  expected_workload_band,content_hash,created_at,published_at
) VALUES
('sv_demo_internal_audit_v3','sp_demo_internal_audit',3,1,'published','d1:scenario-version-content/sv_demo_internal_audit_v3',14,'light','33e5c794ff367c2af4f9bc482b68a8cd39198b8a306f0338c5c6c701d6bbf5c5',unixepoch(),unixepoch()),
('sv_demo_data_analyst_v3','sp_demo_data_analyst',3,1,'published','d1:scenario-version-content/sv_demo_data_analyst_v3',14,'light','23b2cf82f93ed48e1bdfee86f4f11c01e8871b00d7ace4c7f2eafd534b43199c',unixepoch(),unixepoch()),
('sv_demo_software_engineering_v3','sp_demo_software_engineering',3,1,'published','d1:scenario-version-content/sv_demo_software_engineering_v3',14,'light','33577dec9c9f23509e7cde2e54363d4f23f38ad296715a3a0d112d4e23327a0a',unixepoch(),unixepoch());

INSERT OR IGNORE INTO competency_definitions(
  competency_id,definition_version,name,description,domain,parent_competency_id,
  level_framework_version,evidence_requirements_json,transfer_policy_json,
  recency_policy_json,context_metadata_json,status,created_at
) VALUES
('comp_analytical_interpretation',1,'Analytical interpretation','Interprets analytical results with appropriate uncertainty, context and decision relevance.','data_analysis',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_security_asset_review',1,'Asset and security review','Reviews asset and security context using authorized evidence and documented scope.','cybersecurity',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_access_control_analysis',1,'Access-control analysis','Evaluates identity and access-control evidence against least-privilege and governance expectations.','cybersecurity',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_security_risk_triage',1,'Security risk triage','Prioritizes defensive security risks using evidence, context, likelihood and impact.','cybersecurity',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_security_remediation',1,'Security remediation planning','Develops proportionate remediation actions, ownership and follow-up for supported security risks.','cybersecurity',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_financial_reconciliation',1,'Financial reconciliation','Reconciles financial records systematically and documents supported differences.','finance',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_variance_analysis',1,'Variance analysis','Explains material financial variances using traceable drivers, evidence and assumptions.','finance',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_financial_modeling',1,'Financial modeling','Builds transparent financial model logic with explicit assumptions and scenario sensitivity.','finance',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_management_reporting',1,'Management reporting','Communicates financial analysis clearly for management decisions with limitations and assumptions.','finance',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_project_planning',1,'Project planning','Builds structured project plans with milestones, dependencies, responsibilities and delivery logic.','project_operations',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_stakeholder_management',1,'Stakeholder management','Analyzes stakeholder interests and communicates decisions, expectations and escalation appropriately.','project_operations',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_project_risk_management',1,'Project risk management','Identifies, assesses, owns and monitors project risks and issues using evidence-based responses.','project_operations',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch()),
('comp_change_management',1,'Change management','Assesses project changes for scope, schedule, risk, dependency and approval impact.','project_operations',NULL,'phase7-levels-v1','{"emerging":{"min_records":1,"min_candidate":"developing"},"developing":{"min_records":2,"min_candidate":"developing"},"applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},"independent":{"min_records":2,"min_candidate":"independent","min_independent":1},"advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2}}','{"advanced_requires_transfer":true,"context_fields":["career_family","role_family","scenario_pack_id","task_category","domain","work_context"]}','{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging","expires_after_days":null}','{"physical":false}','active',unixepoch());

INSERT INTO persistence_meta(key,value,updated_at)
VALUES ('virtual_internship_phase10_schema_version','1',unixepoch())
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
