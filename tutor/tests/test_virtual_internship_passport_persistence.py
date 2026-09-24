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
        self.assertNotIn("invoke_formal_assessor",source)
        self.assertNotIn("llm",source.lower())

    def test_reconciliation_and_rebuild_are_idempotent_materialization_paths(self):
        source=WORKER.read_text()
        self.assertIn("ON CONFLICT(assessment_id) DO UPDATE",source)
        self.assertIn("SELECT COUNT(*) AS n FROM competency_evidence",source)
        self.assertIn("DELETE FROM competency_passports WHERE learner_id=?",source)
        self.assertIn("p7Rebuild",source)
        self.assertIn("passport/rebuild",source)

    def test_learner_api_uses_authenticated_actor_not_browser_owner_fields(self):
        source=ROUTER.read_text()
        self.assertIn('actor_id=_member(current,"view your Competency Passport")',source)
        self.assertIn("internship_passport_summary(actor_id)",source)
        self.assertIn("internship_passport_evidence(actor_id,competency_id)",source)
        self.assertNotIn("body.learner_id",source)
        self.assertNotIn("body.owner_id",source)

if __name__=="__main__":unittest.main()
