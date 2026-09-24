import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MIGRATION=ROOT/"cloudflare/migrations/0012_virtual_internship_phase6_assessment.sql"
WORKER=ROOT/"cloudflare/src/virtual_internship_phase6.ts"


def bootstrap_prerequisites(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE scenario_packs(
          id TEXT PRIMARY KEY, slug TEXT, title TEXT, career_family TEXT, role_title TEXT,
          status TEXT, created_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE scenario_versions(
          id TEXT PRIMARY KEY, scenario_pack_id TEXT, version INTEGER, schema_version INTEGER,
          status TEXT, manifest_ref TEXT, minimum_duration_days INTEGER,
          expected_workload_band TEXT, content_hash TEXT, created_at INTEGER, published_at INTEGER
        );
        CREATE TABLE internship_instances(
          id TEXT PRIMARY KEY, learner_id TEXT NOT NULL
        );
        CREATE TABLE internship_tasks(
          internship_id TEXT NOT NULL, task_id TEXT NOT NULL,
          PRIMARY KEY(internship_id,task_id)
        );
        CREATE TABLE internship_artifacts(id TEXT PRIMARY KEY);
        CREATE TABLE internship_artifact_versions(id TEXT PRIMARY KEY);
        CREATE TABLE internship_artifact_submissions(id TEXT PRIMARY KEY);
        CREATE TABLE persistence_meta(
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
        );
        """
    )


def install_phase6(db: sqlite3.Connection) -> None:
    bootstrap_prerequisites(db)
    db.executescript(MIGRATION.read_text())
    db.execute("INSERT INTO internship_instances(id,learner_id) VALUES (?,?)",("vi_1","learner_a"))
    db.execute("INSERT INTO internship_tasks(internship_id,task_id) VALUES (?,?)",("vi_1","task_1"))
    db.execute("INSERT INTO internship_artifacts(id) VALUES (?)",("art_1",))
    db.execute("INSERT INTO internship_artifact_versions(id) VALUES (?)",("ver_1",))
    db.execute("INSERT INTO internship_artifact_submissions(id) VALUES (?)",("sub_1",))
    db.commit()


def insert_fixture(db: sqlite3.Connection) -> None:
    db.execute(
        """INSERT INTO internship_assessments(
          id,internship_id,task_id,artifact_id,artifact_version_id,submission_id,
          rubric_id,rubric_schema_version,rubric_hash,assessment_type,status,
          assessor_model_invocation_id,assessor_prompt_version,assessor_schema_version,
          calculation_version,aggregate_numeric,overall_summary,limitations_json,
          request_id,created_at,completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "asm_1","vi_1","task_1","art_1","ver_1","sub_1",
            "rubric_1",1,"a"*64,"artifact","completed",
            "inv_1",1,1,"phase6-weighted-v1","75.00",
            "Formal rubric assessment recorded 1 assessed criterion/criteria.",
            "[]","req_assessment",100,110,
        ),
    )
    db.execute(
        """INSERT INTO internship_assessment_criteria(
          assessment_id,criterion_id,result_state,rating_id,numeric_value,
          feedback,evidence_refs_json,limitation
        ) VALUES (?,?,?,?,?,?,?,?)""",
        (
            "asm_1","technical","assessed","meets","75",
            "The cited line supports the technical conclusion.",
            '[{"artifact_id":"art_1","artifact_version_id":"ver_1","submission_id":"sub_1","locator":{"kind":"line_range","start_line":1,"end_line":2}}]',
            "",
        ),
    )
    db.execute(
        """INSERT INTO internship_assistance_events(
          id,internship_id,task_id,artifact_id,artifact_version_id,source,provenance,
          assistance_level,category,summary,model_invocation_id,event_time,request_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "assist_1","vi_1","task_1","art_1","ver_1","murikah_mentor",
            "system_observed",2,"mentor_guidance","Light coaching recorded.",
            "inv_mentor",90,"req_assist",
        ),
    )
    db.execute(
        """INSERT INTO internship_performance_reviews(
          id,internship_id,review_type,cutoff_at,evidence_snapshot_json,
          evidence_snapshot_hash,status,strengths_json,development_areas_json,
          priorities_json,assistance_summary_json,narrative,model_invocation_id,
          narrative_version,supersedes_review_id,request_id,created_at,finalized_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "review_1","vi_1","midpoint",120,
            '{"assessments":[{"id":"asm_1"}],"assistance_events":[{"id":"assist_1"}]}',
            "b"*64,"finalized",
            '[{"assessment_id":"asm_1","criterion_id":"technical"}]',
            "[]","[]",'{"event_count":1}',"Evidence-grounded midpoint review.",
            "",1,None,"req_review",120,120,
        ),
    )
    db.commit()


class Phase6PersistenceRestartTests(unittest.TestCase):
    def test_restart_preserves_assessment_assistance_review_and_exact_lineage(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"phase6.sqlite3"
            first=sqlite3.connect(path)
            try:
                install_phase6(first)
                insert_fixture(first)
            finally:
                first.close()

            second=sqlite3.connect(path)
            try:
                assessment=second.execute(
                    """SELECT internship_id,task_id,artifact_id,artifact_version_id,submission_id,
                              rubric_id,calculation_version,aggregate_numeric,status
                       FROM internship_assessments WHERE id='asm_1'"""
                ).fetchone()
                criterion=second.execute(
                    "SELECT criterion_id,rating_id,evidence_refs_json FROM internship_assessment_criteria WHERE assessment_id='asm_1'"
                ).fetchone()
                assistance=second.execute(
                    "SELECT source,provenance,assistance_level,artifact_version_id,event_time FROM internship_assistance_events WHERE id='assist_1'"
                ).fetchone()
                review=second.execute(
                    "SELECT review_type,evidence_snapshot_hash,status FROM internship_performance_reviews WHERE id='review_1'"
                ).fetchone()
            finally:
                second.close()

            self.assertEqual(
                assessment,
                ("vi_1","task_1","art_1","ver_1","sub_1","rubric_1","phase6-weighted-v1","75.00","completed"),
            )
            self.assertEqual(criterion[0:2],("technical","meets"))
            self.assertIn('"artifact_version_id":"ver_1"',criterion[2])
            self.assertEqual(assistance,("murikah_mentor","system_observed",2,"ver_1",90))
            self.assertEqual(review,("midpoint","b"*64,"finalized"))

    def test_completed_and_finalized_history_stays_immutable_after_restart(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"phase6.sqlite3"
            first=sqlite3.connect(path)
            install_phase6(first)
            insert_fixture(first)
            first.close()

            second=sqlite3.connect(path)
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    second.execute("UPDATE internship_assessments SET aggregate_numeric='100' WHERE id='asm_1'")
                with self.assertRaises(sqlite3.IntegrityError):
                    second.execute("UPDATE internship_assessment_criteria SET rating_id='other' WHERE assessment_id='asm_1'")
                with self.assertRaises(sqlite3.IntegrityError):
                    second.execute("UPDATE internship_assistance_events SET assistance_level=5 WHERE id='assist_1'")
                with self.assertRaises(sqlite3.IntegrityError):
                    second.execute("UPDATE internship_performance_reviews SET narrative='rewritten' WHERE id='review_1'")
            finally:
                second.close()

    def test_owner_gate_precedes_every_phase6_learner_route(self):
        source=WORKER.read_text()
        owner_lookup=source.index("const owned=await ownedInternship")
        owner_reject=source.index("if(!owned)return json({error:'internship_not_found'},404)")
        first_route=min(
            source.index("if(route==='/internships/assessments/summary'"),
            source.index("if(route==='/internships/assessments/start'"),
            source.index("if(route==='/internships/assistance/record'"),
            source.index("if(route==='/internships/performance-reviews/record'"),
        )
        self.assertLess(owner_lookup,owner_reject)
        self.assertLess(owner_reject,first_route)
        self.assertIn("WHERE i.id = ? AND i.learner_id = ? LIMIT 1",source)
        self.assertIn("a.id = ? AND a.internship_id = ? AND i.learner_id = ? LIMIT 1",source)
        self.assertNotIn("owner_id = body",source)


if __name__=="__main__":
    unittest.main()
