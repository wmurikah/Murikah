import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "cloudflare/migrations"
PHASE1 = MIGRATIONS / "0006_virtual_internship_phase1.sql"
PHASE8 = MIGRATIONS / "0014_virtual_internship_phase8_completion.sql"
WORKER = ROOT / "cloudflare/src/virtual_internship_phase8.ts"
ROUTER = ROOT / "railway/murikah_virtual_internship.py"


def install_phase1_and_phase8(db: sqlite3.Connection) -> None:
    db.executescript("""
    PRAGMA foreign_keys=ON;
    CREATE TABLE tutor_accounts(
      actor_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'member',
      account_status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE persistence_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    """)
    db.executescript(PHASE1.read_text())
    db.executescript(PHASE8.read_text())


class CompletionPersistenceTests(unittest.TestCase):
    def test_phase8_migration_applies_after_complete_current_schema(self):
        with tempfile.TemporaryDirectory() as td:
            db = sqlite3.connect(Path(td) / "full-schema.sqlite3")
            db.execute("PRAGMA foreign_keys=ON")
            migrations = sorted(
                path for path in MIGRATIONS.glob("*.sql")
                if path.name <= PHASE8.name
            )
            self.assertGreaterEqual(len(migrations), 14)
            for migration in migrations:
                db.executescript(migration.read_text())
            self.assertEqual(
                db.execute(
                    "SELECT value FROM persistence_meta WHERE key='virtual_internship_phase8_completion_schema_version'"
                ).fetchone()[0],
                "1",
            )
            instance_sql = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='internship_instances'"
            ).fetchone()[0]
            membership_sql = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='internship_memberships'"
            ).fetchone()[0]
            self.assertIn("'completed'", instance_sql)
            self.assertIn("'completed'", membership_sql)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_forward_migration_extends_lifecycle_and_preserves_phase1_guard(self):
        with tempfile.TemporaryDirectory() as td:
            db = sqlite3.connect(Path(td) / "phase8.sqlite3")
            install_phase1_and_phase8(db)
            columns = {row[1] for row in db.execute("PRAGMA table_info(internship_instances)")}
            self.assertIn("status", columns)
            self.assertIn("completed_at", columns)
            self.assertIn("phase1_completed_at_guard", columns)
            self.assertNotIn("phase1_status", columns)
            sql = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='internship_instances'"
            ).fetchone()[0]
            self.assertIn("'completed'", sql)
            self.assertIn("phase1_completed_at_guard IS NULL", sql)

    def test_completed_no_longer_consumes_one_active_qualifying_slot(self):
        with tempfile.TemporaryDirectory() as td:
            db = sqlite3.connect(Path(td) / "active.sqlite3")
            install_phase1_and_phase8(db)
            db.execute("INSERT INTO tutor_accounts(actor_id) VALUES ('learner_a')")
            db.execute(
                "INSERT INTO scenario_packs(id,slug,title,career_family,role_title,status,created_at,updated_at) "
                "VALUES ('sp_1','scenario-one','Scenario One','audit','Intern','published',1,1)"
            )
            db.execute(
                "INSERT INTO scenario_versions(id,scenario_pack_id,version,schema_version,minimum_duration_days,expected_workload_band,status,content_hash,manifest_ref,created_at) "
                "VALUES ('sv_1','sp_1',1,1,90,'standard','published',?, 'manifest.json',1)",
                ("a" * 64,),
            )
            db.execute(
                "INSERT INTO internship_instances(id,learner_id,scenario_pack_id,scenario_version_id,mode,qualifying,status,lifecycle_stage,started_at,minimum_duration_days,target_end_at,start_request_id,created_at,updated_at) "
                "VALUES ('vi_1','learner_a','sp_1','sv_1','standard',1,'active','started',1,90,7776001,'start-vi-1',1,1)"
            )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO internship_instances(id,learner_id,scenario_pack_id,scenario_version_id,mode,qualifying,status,lifecycle_stage,started_at,minimum_duration_days,target_end_at,start_request_id,created_at,updated_at) "
                    "VALUES ('vi_conflict','learner_a','sp_1','sv_1','standard',1,'active','started',2,90,7776002,'start-vi-conflict',2,2)"
                )
            db.execute("UPDATE internship_instances SET status='completed', completed_at=7776001 WHERE id='vi_1'")
            db.execute(
                "INSERT INTO internship_instances(id,learner_id,scenario_pack_id,scenario_version_id,mode,qualifying,status,lifecycle_stage,started_at,minimum_duration_days,target_end_at,start_request_id,created_at,updated_at) "
                "VALUES ('vi_2','learner_a','sp_1','sv_1','standard',1,'active','started',7776002,90,15552002,'start-vi-2',7776002,7776002)"
            )
            self.assertEqual(
                db.execute("SELECT status FROM internship_instances WHERE id='vi_1'").fetchone()[0],
                "completed",
            )
            self.assertEqual(
                db.execute("SELECT status FROM internship_instances WHERE id='vi_2'").fetchone()[0],
                "active",
            )

    def test_completion_records_are_unique_immutable_and_versioned(self):
        sql = PHASE8.read_text()
        self.assertIn("internship_id TEXT NOT NULL UNIQUE", sql)
        self.assertIn("completion_policy_hash TEXT NOT NULL", sql)
        self.assertIn("gate_snapshot_json TEXT NOT NULL", sql)
        self.assertIn("gate_snapshot_hash TEXT NOT NULL", sql)
        self.assertIn("evaluator_version TEXT NOT NULL", sql)
        self.assertIn("passport_aggregation_ruleset_versions_json", sql)
        self.assertIn("evidence_ruleset_versions_json", sql)
        self.assertIn("evidence_refs_json", sql)
        self.assertIn("completion_record_immutable", sql)
        self.assertNotIn("certificate", sql.lower())
        self.assertNotIn("verification_id", sql.lower())

    def test_worker_uses_server_time_and_all_deterministic_gates(self):
        source = WORKER.read_text()
        self.assertIn("elapsedSeconds >= requiredDurationDays * INTERNSHIP_DAY_SECONDS", source)
        self.assertIn("Number(row.minimum_duration_days", source)
        self.assertIn("required_tasks_incomplete", source)
        self.assertIn("required_review_missing", source)
        self.assertIn("competency_evidence_insufficient", source)
        self.assertIn("capstone_incomplete", source)
        self.assertIn("final_review_missing", source)
        self.assertIn("final_review_precedes_capstone", source)
        self.assertIn("completion_policy_unavailable", source)
        self.assertNotIn("STANDARD_MINIMUM_INTERNSHIP_DAYS = 90", source)
        for provider in ("openai", "claude", "gemini", "qwen", "nvidia"):
            self.assertNotIn(provider, source.lower())
        self.assertNotIn("TUTOR_FILES", source)
        self.assertNotIn("chain_of_thought", source)

    def test_duration_boundaries_follow_exact_utc_seconds(self):
        day = 24 * 60 * 60
        passes = lambda started, minimum, now: max(0, now - started) >= minimum * day
        self.assertFalse(passes(0, 90, 89 * day))
        self.assertFalse(passes(0, 90, 90 * day - 1))
        self.assertTrue(passes(0, 90, 90 * day))
        self.assertTrue(passes(0, 90, 91 * day))
        self.assertFalse(passes(0, 120, 90 * day))
        self.assertTrue(passes(0, 120, 120 * day))

    def test_demo_test_and_nonqualifying_records_fail_closed(self):
        source = WORKER.read_text()
        self.assertIn("Number(row.qualifying) === 1", source)
        self.assertIn("String(row.mode) === 'standard'", source)
        self.assertIn("manifest?.qualifying === true", source)
        self.assertIn("manifest.classification", source)
        self.assertIn("non_qualifying_internship", source)
        self.assertNotRegex(source, re.compile(r"skip90days|forcecomplete|democomplete", re.I))

    def test_finalization_rechecks_and_is_idempotent_owner_scoped(self):
        source = WORKER.read_text()
        self.assertIn("Never trust a browser eligibility response", source)
        self.assertIn("evaluateCompletionEligibility(db, actorId, internshipId, now)", source)
        self.assertIn("INSERT OR IGNORE INTO completion_records", source)
        self.assertIn("WHERE i.id=? AND i.learner_id=?", source)
        self.assertIn("UPDATE internship_memberships SET status='completed'", source)
        self.assertIn("'internship_completed'", source)
        self.assertIn("loadCompletionRecord(db, internshipId, actorId)", source)
        self.assertIn("db.batch([", source)
        self.assertIn("gate_snapshot_hash", PHASE8.read_text())

    def test_idempotent_replay_recovers_active_partial_lifecycle_safely(self):
        source = WORKER.read_text()
        self.assertIn("async function recoverCompletionLifecycle(", source)
        self.assertIn("if (String(row.status) === 'active')", source)
        self.assertIn("recoverCompletionLifecycle(db, actorId, internshipId, replay, now)", source)
        self.assertIn("internship_completion_integrity_conflict", source)
        self.assertIn("Never rewrite the immutable completion record", source)

    def test_learner_route_accepts_only_request_identity_not_gate_assertions(self):
        source = ROUTER.read_text()
        self.assertIn('actor_id=_member(current,"view internship completion requirements")', source)
        self.assertIn('actor_id=_member(current,"complete an internship")', source)
        self.assertIn("internship_completion_finalize(", source)
        self.assertNotIn("duration_met:", source)
        self.assertNotIn("tasks_complete:", source)
        self.assertNotIn("evidence_complete:", source)


if __name__ == "__main__":
    unittest.main()
