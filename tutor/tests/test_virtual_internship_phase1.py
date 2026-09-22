"""Phase 1 D1 schema, versioning, lifecycle, and persistence tests."""
from pathlib import Path
import sqlite3
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "cloudflare/migrations/0006_virtual_internship_phase1.sql"


def open_phase1(path=":memory:"):
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS persistence_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tutor_accounts (
          actor_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          account_status TEXT NOT NULL,
          email_verified_at INTEGER
        );
        """
    )
    db.executescript(MIGRATION.read_text(encoding="utf-8"))
    return db


def account(db, actor_id):
    db.execute(
        "INSERT INTO tutor_accounts(actor_id, role, account_status, email_verified_at) "
        "VALUES (?, 'member', 'active', 1700000000)",
        (actor_id,),
    )


def instance(
    db,
    internship_id,
    learner_id,
    scenario_version_id="scenario_phase1_foundation_v1",
    started_at=1700000000,
    minimum_days=90,
):
    target = started_at + minimum_days * 86400
    db.execute(
        "INSERT INTO internship_instances("
        "id, learner_id, scenario_pack_id, scenario_version_id, mode, qualifying, "
        "status, lifecycle_stage, started_at, minimum_duration_days, target_end_at, "
        "created_at, updated_at"
        ") VALUES (?, ?, 'scenario_phase1_foundation', ?, 'standard', 1, "
        "'active', 'started', ?, ?, ?, ?, ?)",
        (
            internship_id,
            learner_id,
            scenario_version_id,
            started_at,
            minimum_days,
            target,
            started_at,
            started_at,
        ),
    )
    return target


class VirtualInternshipPhase1Tests(unittest.TestCase):
    def test_migration_has_only_phase1_tables_and_expected_indexes(self):
        db = open_phase1()
        tables = {
            row[0]
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        for name in (
            "scenario_packs",
            "scenario_versions",
            "internship_instances",
            "internship_memberships",
            "internship_activity",
        ):
            self.assertIn(name, tables)
        self.assertNotIn("virtual_internship_objects", tables)
        indexes = {
            row[0]
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
        for name in (
            "idx_scenario_versions_pack_status_version",
            "idx_internship_instances_one_active_qualifying",
            "idx_internship_instances_learner_status",
            "idx_internship_instances_scenario_version",
            "idx_internship_memberships_actor",
            "idx_internship_activity_internship_time",
            "idx_internship_activity_single_start",
            "idx_internship_activity_single_stop",
        ):
            self.assertIn(name, indexes)

    def test_migration_avoids_brittle_cloudflare_constructs(self):
        sql = MIGRATION.read_text(encoding="utf-8").upper()
        self.assertNotIn("CREATE TRIGGER", sql)
        self.assertNotIn("\nBEGIN ", sql)
        self.assertIn("VIRTUAL_INTERNSHIP_PHASE1_SCHEMA_VERSION", sql)

    def test_one_active_qualifying_internship_is_database_enforced(self):
        db = open_phase1()
        account(db, "member_a")
        instance(db, "internship_a1", "member_a")
        with self.assertRaises(sqlite3.IntegrityError):
            instance(db, "internship_a2", "member_a")

        stopped_at = 1700000100
        db.execute(
            "UPDATE internship_instances SET status='stopped', lifecycle_stage='stopped', "
            "stopped_at=?, updated_at=? WHERE id='internship_a1' AND learner_id='member_a'",
            (stopped_at, stopped_at),
        )
        instance(db, "internship_a2", "member_a")
        self.assertEqual(
            db.execute(
                "SELECT COUNT(*) FROM internship_instances "
                "WHERE learner_id='member_a' AND status='active' AND qualifying=1"
            ).fetchone()[0],
            1,
        )

    def test_scenario_version_history_does_not_move_when_v2_is_published(self):
        db = open_phase1()
        account(db, "member_v1")
        account(db, "member_v2")
        instance(db, "internship_v1", "member_v1")

        db.execute(
            "INSERT INTO scenario_versions("
            "id, scenario_pack_id, version, schema_version, status, manifest_json, "
            "minimum_duration_days, expected_workload_band, content_hash, created_at, published_at"
            ") VALUES ('scenario_phase1_foundation_v2', 'scenario_phase1_foundation', "
            "2, 1, 'published', '{\"phase\":1,\"foundation_only\":true}', "
            "120, 'standard', 'phase1-foundation-v2', 1700000200, 1700000200)"
        )
        self.assertEqual(
            db.execute(
                "SELECT scenario_version_id FROM internship_instances WHERE id='internship_v1'"
            ).fetchone()[0],
            "scenario_phase1_foundation_v1",
        )
        newest = db.execute(
            "SELECT id FROM scenario_versions "
            "WHERE scenario_pack_id='scenario_phase1_foundation' AND status='published' "
            "ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        self.assertEqual(newest, "scenario_phase1_foundation_v2")
        instance(
            db,
            "internship_v2",
            "member_v2",
            scenario_version_id=newest,
            minimum_days=120,
        )
        self.assertEqual(
            db.execute(
                "SELECT scenario_version_id, minimum_duration_days "
                "FROM internship_instances WHERE id='internship_v2'"
            ).fetchone(),
            ("scenario_phase1_foundation_v2", 120),
        )

    def test_activity_request_replay_and_single_lifecycle_events_are_constrained(self):
        db = open_phase1()
        account(db, "member_replay")
        instance(db, "internship_replay", "member_replay")
        db.execute(
            "INSERT INTO internship_activity(id, internship_id, actor_id, event_type, request_id, created_at) "
            "VALUES ('activity_start_1', 'internship_replay', 'member_replay', "
            "'internship_started', 'request_start_1', 1700000000)"
        )
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute(
                "INSERT INTO internship_activity(id, internship_id, actor_id, event_type, request_id, created_at) "
                "VALUES ('activity_start_2', 'internship_replay', 'member_replay', "
                "'internship_started', 'request_start_1', 1700000001)"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute(
                "INSERT INTO internship_activity(id, internship_id, actor_id, event_type, request_id, created_at) "
                "VALUES ('activity_start_3', 'internship_replay', 'member_replay', "
                "'internship_started', 'request_start_2', 1700000002)"
            )

    def test_state_survives_fresh_database_adapter_instance(self):
        with tempfile.TemporaryDirectory(prefix="muri-internship-phase1-") as tmp:
            path = str(Path(tmp) / "phase1.sqlite3")
            db = open_phase1(path)
            account(db, "member_restart")
            target = instance(db, "internship_restart", "member_restart")
            db.commit()
            db.close()

            fresh = sqlite3.connect(path)
            row = fresh.execute(
                "SELECT learner_id, status, scenario_version_id, target_end_at "
                "FROM internship_instances WHERE id='internship_restart'"
            ).fetchone()
            fresh.close()
            self.assertEqual(
                row,
                (
                    "member_restart",
                    "active",
                    "scenario_phase1_foundation_v1",
                    target,
                ),
            )


if __name__ == "__main__":
    unittest.main()
