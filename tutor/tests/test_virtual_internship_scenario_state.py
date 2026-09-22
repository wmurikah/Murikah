"""Phase 2 D1 runtime model, ownership, concurrency and restart contract tests."""
from __future__ import annotations
import sqlite3,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
MIGRATION=ROOT/"cloudflare/migrations/0008_virtual_internship_phase2.sql"

class ScenarioStateTests(unittest.TestCase):
    def test_migration_separates_immutable_definitions_and_runtime_state(self):
        sql=MIGRATION.read_text()
        for table in (
          "scenario_version_content","scenario_actors","scenario_facts","scenario_actor_knowledge",
          "scenario_task_definitions","scenario_task_dependencies","scenario_event_definitions","scenario_event_triggers",
          "scenario_decision_options","internship_scenario_state","internship_scenario_facts","internship_tasks",
          "internship_event_state","internship_decisions","internship_event_firings","internship_state_changes",
        ):self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}",sql)
        self.assertIn("PRIMARY KEY (internship_id, revision)",sql)
        self.assertIn("PRIMARY KEY (internship_id, event_id)",sql)
        self.assertNotIn("scenario_owner_id",sql);self.assertNotIn("engine_owner_id",sql)

    def test_restart_reads_same_d1_state(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite3") as handle:
            db=sqlite3.connect(handle.name)
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript("""
              CREATE TABLE persistence_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
              CREATE TABLE scenario_versions(id TEXT PRIMARY KEY) STRICT;
              CREATE TABLE internship_instances(id TEXT PRIMARY KEY) STRICT;
            """)
            db.executescript(MIGRATION.read_text())
            db.execute("INSERT INTO scenario_versions(id) VALUES ('sv_test')")
            db.execute("INSERT INTO scenario_version_content VALUES ('sv_test',1,'d1:scenario-version-content/sv_test','{}',?,1)",("a"*64,))
            db.execute("INSERT INTO internship_instances(id) VALUES ('vi_test')")
            db.execute("INSERT INTO internship_scenario_state VALUES ('vi_test','sv_test','ready',3,10,20)")
            db.commit();db.close()
            fresh=sqlite3.connect(handle.name)
            self.assertEqual(fresh.execute("SELECT status,revision FROM internship_scenario_state WHERE internship_id='vi_test'").fetchone(),("ready",3))
            fresh.close()

    def test_worker_has_owner_bound_views_atomic_start_and_no_generic_patch(self):
        worker=(ROOT/"cloudflare/src/index.ts").read_text()
        engine=(ROOT/"cloudflare/src/virtual_internship_phase2.ts").read_text()
        self.assertIn("...scenarioInitialization",worker)
        self.assertIn("WHERE id = ? AND learner_id = ? LIMIT 1",engine)
        self.assertIn("PRIMARY KEY",MIGRATION.read_text())
        self.assertIn("scenario_revision_conflict",engine)
        self.assertNotIn("PATCH /scenario-state",engine)
        self.assertNotIn("patch_state(dict)",engine)
        self.assertNotIn("set_fact_from_client",engine)
        self.assertIn("canonical_state','patch_state",engine)
        self.assertIn("scenario_immutable_fact",engine)

    def test_persistence_adapter_is_actor_bound_and_typed(self):
        persistence=(ROOT/"railway/murikah_persistence.py").read_text()
        for name in ("scenario_definition_get","scenario_initialize","scenario_state_get","scenario_actor_view","scenario_learner_view","scenario_task_transition","scenario_record_decision","scenario_evaluate"):
            self.assertIn(f"def {name}(",persistence)
        self.assertNotIn("def scenario_patch_state(",persistence)

    def test_phase1_semantics_remain_protected(self):
        worker=(ROOT/"cloudflare/src/index.ts").read_text()
        migration=(ROOT/"cloudflare/migrations/0006_virtual_internship_phase1.sql").read_text()
        self.assertIn("STANDARD_MINIMUM_INTERNSHIP_DAYS = 90",worker)
        self.assertNotIn("/internships/complete",worker)
        self.assertIn("phase1-foundation-no-task-graph",migration)
        self.assertIn("'active', 'stopped'",migration)

if __name__=="__main__":unittest.main()
