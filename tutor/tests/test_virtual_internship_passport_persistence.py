import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MIGRATION=ROOT/"cloudflare/migrations/0013_virtual_internship_phase7_passport.sql"
WORKER=ROOT/"cloudflare/src/virtual_internship_phase7.ts"
ROUTER=ROOT/"railway/murikah_virtual_internship.py"

def bootstrap(db:sqlite3.Connection):
    db.executescript("""
    PRAGMA foreign_keys=ON;
    CREATE TABLE persistence_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE tutor_accounts(actor_id TEXT PRIMARY KEY);
    CREATE TABLE scenario_versions(id TEXT PRIMARY KEY);
    CREATE TABLE internship_instances(id TEXT PRIMARY KEY,learner_id TEXT NOT NULL);
    CREATE TABLE internship_artifacts(id TEXT PRIMARY KEY);
    CREATE TABLE internship_artifact_versions(id TEXT PRIMARY KEY);
    CREATE TABLE internship_artifact_submissions(id TEXT PRIMARY KEY);
    CREATE TABLE internship_assessments(id TEXT PRIMARY KEY);
    CREATE TABLE internship_assessment_criteria(
      assessment_id TEXT NOT NULL,criterion_id TEXT NOT NULL,
      PRIMARY KEY(assessment_id,criterion_id)
    );
    """)
    for value in ("sv_demo_internal_audit_v2","sv_demo_data_analyst_v2","sv_demo_software_engineering_v2"):
        db.execute("INSERT INTO scenario_versions(id) VALUES (?)",(value,))
    db.commit()

class Phase7PersistenceTests(unittest.TestCase):
    def test_migration_installs_seeded_versioned_authority_and_indexes(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"p7.sqlite3"
            db=sqlite3.connect(path)
            bootstrap(db)
            db.executescript(MIGRATION.read_text())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM competency_definitions").fetchone()[0],11)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM competency_assessment_mappings").fetchone()[0],33)
            self.assertEqual(db.execute("SELECT value FROM persistence_meta WHERE key='virtual_internship_phase7_passport_schema_version'").fetchone()[0],"1")
            names={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            self.assertIn("idx_competency_evidence_learner_competency",names)
            self.assertIn("idx_competency_passports_learner",names)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE competency_definitions SET name='rewritten' WHERE competency_id='comp_reconciliation'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO competency_definitions SELECT * FROM competency_definitions WHERE competency_id='comp_reconciliation' AND definition_version=1"
                )
            db.close()
            reopened=sqlite3.connect(path)
            self.assertEqual(reopened.execute("SELECT COUNT(*) FROM competency_definitions").fetchone()[0],11)
            reopened.close()

    def test_worker_derives_only_from_completed_phase6_lineage_and_authored_mapping(self):
        source=WORKER.read_text()
        self.assertIn("a.status='completed'",source)
        self.assertIn("competency_assessment_mappings",source)
        self.assertIn("internship_assessment_criteria",source)
        self.assertIn("artifact_version_id",source)
        self.assertIn("submission_id",source)
        self.assertIn("event_time<=?",source)
        self.assertIn("UNIQUE",MIGRATION.read_text())
        self.assertIn("mapping_version INTEGER NOT NULL",MIGRATION.read_text())
        self.assertNotIn("invoke_formal_assessor",source)
        self.assertNotIn("llm",source.lower())

    def test_reconciliation_and_rebuild_are_idempotent_materialization_paths(self):
        source=WORKER.read_text()
        self.assertIn("ON CONFLICT(assessment_id) DO UPDATE",source)
        self.assertIn("SELECT COUNT(*) AS n FROM competency_evidence",source)
        self.assertIn("LEFT JOIN competency_derivation_status",source)
        self.assertIn("current_mapping_version",source)
        self.assertIn("ds.mapping_version<>",source)
        self.assertIn("p7RefreshPassport",source)
        self.assertIn("p7Rebuild",source)
        self.assertIn("passport/rebuild",source)
        self.assertIn("competency_definition_compatibility",source)
        self.assertIn("expires_after_days",source)


    def test_restart_preserves_evidence_and_materialized_passport_without_process_memory(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"restart.sqlite3"
            db=sqlite3.connect(path)
            bootstrap(db)
            db.executescript(MIGRATION.read_text())
            db.execute("INSERT INTO tutor_accounts(actor_id) VALUES ('learner_a')")
            db.execute("INSERT INTO internship_instances(id,learner_id) VALUES ('vi_1','learner_a')")
            db.execute("INSERT INTO internship_artifacts(id) VALUES ('art_1')")
            db.execute("INSERT INTO internship_artifact_versions(id) VALUES ('ver_1')")
            db.execute("INSERT INTO internship_artifact_submissions(id) VALUES ('sub_1')")
            db.execute("INSERT INTO internship_assessments(id) VALUES ('asm_1')")
            db.execute("INSERT INTO internship_assessment_criteria(assessment_id,criterion_id) VALUES ('asm_1','evidence_reasoning')")
            evidence_values=(
                "ce_1","learner_a","comp_reconciliation",1,"","vi_1","sp_demo_internal_audit",
                "sv_demo_internal_audit_v2","task_reconcile_sample","art_1","ver_1","sub_1","asm_1",
                "evidence_reasoning",1,"meets","75","independent",0,"{}","{}","strong","{}",
                '{"career_family":"internal_audit","work_context":"reconciliation"}',"[]",
                "virtual_internship","phase7-evidence-strength-v1",100,
            )
            db.execute(
                """INSERT INTO competency_evidence(
                id,learner_id,competency_id,definition_version,sub_competency_id,internship_id,
                scenario_pack_id,scenario_version_id,task_id,artifact_id,artifact_version_id,submission_id,
                assessment_id,criterion_id,mapping_version,criterion_rating_id,criterion_numeric,
                demonstrated_level,assistance_level,assistance_context_json,revision_context_json,
                evidence_strength,strength_factors_json,transfer_context_json,limitations_json,
                source_type,evidence_ruleset_version,created_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                evidence_values,
            )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    """INSERT INTO competency_evidence(
                    id,learner_id,competency_id,definition_version,sub_competency_id,internship_id,
                    scenario_pack_id,scenario_version_id,task_id,artifact_id,artifact_version_id,submission_id,
                    assessment_id,criterion_id,mapping_version,criterion_rating_id,criterion_numeric,
                    demonstrated_level,assistance_level,assistance_context_json,revision_context_json,
                    evidence_strength,strength_factors_json,transfer_context_json,limitations_json,
                    source_type,evidence_ruleset_version,created_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    ("ce_retry",)+evidence_values[1:],
                )
            db.execute(
                """INSERT INTO competency_passports(
                learner_id,competency_id,definition_version,current_level,evidence_strength_summary,
                evidence_count,independent_count,assisted_count,distinct_task_count,distinct_context_count,
                distinct_internship_count,trend,last_demonstrated_at,explanation_json,next_requirements_json,
                aggregation_ruleset_version,calculated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    "learner_a","comp_reconciliation",1,"emerging","strong",1,1,0,1,1,1,
                    "insufficient_evidence",100,'{"qualifying_evidence_records":1}',"[]",
                    "phase7-passport-aggregation-v1",101,
                ),
            )
            db.commit()
            db.close()

            reopened=sqlite3.connect(path)
            self.assertEqual(
                reopened.execute("SELECT id,artifact_version_id,submission_id,mapping_version FROM competency_evidence").fetchone(),
                ("ce_1","ver_1","sub_1",1),
            )
            self.assertEqual(
                reopened.execute("SELECT current_level,evidence_count,aggregation_ruleset_version FROM competency_passports").fetchone(),
                ("emerging",1,"phase7-passport-aggregation-v1"),
            )
            reopened.close()

    def test_learner_api_uses_authenticated_actor_not_browser_owner_fields(self):
        source=ROUTER.read_text()
        self.assertIn('actor_id=_member(current,"view your Competency Passport")',source)
        self.assertIn("internship_passport_summary(actor_id)",source)
        self.assertIn("internship_passport_evidence(actor_id,competency_id)",source)
        self.assertNotIn("body.learner_id",source)
        self.assertNotIn("body.owner_id",source)

if __name__=="__main__":unittest.main()
