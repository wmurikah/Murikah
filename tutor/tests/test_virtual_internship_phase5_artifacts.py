from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "railway"))

from virtual_internship.ai.outputs import StructuredOutputError, validate_workflow_review_output
from virtual_internship.workspace import VirtualInternshipWorkspaceService

MIGRATION = ROOT / "cloudflare/migrations/0011_virtual_internship_phase5_artifacts.sql"
WORKER = ROOT / "cloudflare/src/virtual_internship_phase5.ts"
ROUTER = ROOT / "railway/murikah_virtual_internship.py"
UI = ROOT / "railway/MurikahVirtualInternshipWorkspace.tsx.txt"


class Phase5Persistence:
    def internship_ui_current(self, actor):
        return {"internship_id": "vi_1"}
    def internship_status(self, actor, internship):
        if actor != "learner_a":
            raise RuntimeError("HTTP 404: internship_not_found")
        return {"internship": {
            "internship_id": "vi_1", "status": "active", "lifecycle_stage": "started",
            "scenario_pack": {"title": "Demo", "role_title": "Analyst Intern"},
            "scenario_version": {"version": 1}, "qualifying": False,
            "started_at": 100, "target_end_at": 100 + 90 * 86400,
            "current_server_time": 200, "minimum_duration_days": 90,
            "elapsed_days": 1, "stopped_at": 0,
        }}
    def internship_ui_threads(self, actor, internship):
        return {"threads": []}
    def internship_ui_reflections(self, actor, internship):
        return {"reflections": []}
    def internship_artifact_summary(self, actor, internship):
        if actor != "learner_a":
            raise RuntimeError("HTTP 404: internship_not_found")
        return {
            "acknowledgements": [{"task_id": "task_1", "acknowledged_at": 120}],
            "artifacts": [{
                "id": "art_1", "task_id": "task_1", "deliverable_type": "memo",
                "artifact_type": "memo", "title": "Memo", "status": "changes_requested",
                "current_version_id": "ver_2", "current_version_number": 2,
                "current_filename": "Memo.md", "current_content_type": "text/markdown",
                "current_size_bytes": 120, "current_source_type": "text",
                "created_at": 121, "updated_at": 150,
            }],
            "versions": [
                {"id": "ver_2", "artifact_id": "art_1", "task_id": "task_1", "version_number": 2,
                 "original_filename": "Memo.md", "content_type": "text/markdown", "size_bytes": 120,
                 "source_type": "text", "created_at": 145, "submitted": 1},
                {"id": "ver_1", "artifact_id": "art_1", "task_id": "task_1", "version_number": 1,
                 "original_filename": "Memo.md", "content_type": "text/markdown", "size_bytes": 90,
                 "source_type": "text", "created_at": 130, "submitted": 0},
            ],
            "submissions": [{
                "id": "sub_1", "artifact_id": "art_1", "artifact_version_id": "ver_2",
                "task_id": "task_1", "submission_number": 1, "submitted_at": 146,
                "status": "changes_requested",
            }],
            "reviews": [{
                "id": "rev_1", "task_id": "task_1", "artifact_id": "art_1",
                "submission_id": "sub_1", "reviewer_actor_id": "supervisor",
                "review_type": "workflow", "decision": "changes_requested",
                "feedback": "Reconcile the difference.", "requested_changes": ["Tie the total to source."],
                "created_at": 150,
            }],
            "activity": [{
                "id": "act_1", "task_id": "task_1", "event_type": "changes_requested",
                "event_time": 150,
            }],
        }


class Phase5State:
    def learner_view(self, actor, internship):
        return {"view": {
            "scenario_version_id": "sv_1",
            "facts": [],
            "tasks": [{"task_id": "task_1", "status": "in_progress", "due_at": 900}],
            "fired_events": [],
        }}
    def definition(self, actor, internship):
        return {"definition": {
            "manifest": {"title": "Demo", "role_title": "Analyst Intern", "classification": "demo", "scenario_version": 1},
            "company": {"name": "Fictional Co", "fictional": True, "departments": [], "products_services": [],
                        "systems": [], "process_references": [], "communication_norms": [], "work_calendar": {}},
            "facts": [],
            "actors": [{"actor_id": "supervisor", "name": "Amina", "actor_class": "supervisor",
                        "job_title": "Supervisor", "department_id": "ops", "reports_to_actor_id": None,
                        "learner_relationship": "supervisor", "active": True}],
            "tasks": [{"task_id": "task_1", "title": "Prepare memo", "category": "communication",
                       "assigned_by_actor_id": "supervisor", "business_context": "Context",
                       "learner_objective": "Objective", "brief": "Brief", "dependencies": [],
                       "expected_effort": "2h", "difficulty": "intermediate", "allowed_tools": ["document_editor"],
                       "allowed_mentor_support": "clarification", "stakeholder_actor_ids": ["supervisor"],
                       "deliverable_types": ["memo"]}],
            "events": [], "decisions": [],
        }}


class Phase5ArtifactTests(unittest.TestCase):
    def test_workflow_review_schema_is_phase5_only(self):
        value = validate_workflow_review_output({
            "schema_version": 1,
            "decision": "changes_requested",
            "feedback": "Reconcile the source — then resubmit.",
            "requested_changes": ["Tie the balance — to the source."],
        })
        self.assertEqual(value["decision"], "changes_requested")
        self.assertNotIn("—", json.dumps(value))
        with self.assertRaises(StructuredOutputError):
            validate_workflow_review_output({
                "schema_version": 1, "decision": "accepted", "feedback": "Ready.",
                "requested_changes": [], "score": 95,
            })
        with self.assertRaises(StructuredOutputError):
            validate_workflow_review_output({
                "schema_version": 1, "decision": "accepted", "feedback": "Ready.",
                "requested_changes": ["Change something"],
            })

    def test_workspace_exposes_real_artifact_state_without_score(self):
        workspace = VirtualInternshipWorkspaceService(Phase5Persistence(), Phase5State()).workspace("learner_a", "vi_1")
        task = workspace["tasks"][0]
        self.assertEqual(task["work_status"], "changes_requested")
        self.assertEqual(task["acknowledged_at"], 120)
        self.assertEqual(task["work_artifacts"][0]["versions"][0]["version_number"], 2)
        self.assertEqual(task["work_artifacts"][0]["reviews"][0]["decision"], "changes_requested")
        dumped = json.dumps(workspace).lower()
        for forbidden in ("competency_level", "rubric_score", "passport_evidence", '"score"'):
            self.assertNotIn(forbidden, dumped)

    def test_schema_preserves_immutable_lineage_and_uniqueness(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite3") as handle:
            db = sqlite3.connect(handle.name)
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript("""
                CREATE TABLE persistence_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
                CREATE TABLE tutor_accounts(actor_id TEXT PRIMARY KEY) STRICT;
                CREATE TABLE internship_instances(id TEXT PRIMARY KEY) STRICT;
                CREATE TABLE internship_tasks(
                    internship_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
                    PRIMARY KEY(internship_id, task_id)
                ) STRICT;
                CREATE TABLE tutor_objects(object_id TEXT PRIMARY KEY) STRICT;
            """)
            db.executescript(MIGRATION.read_text())
            for table in (
                "internship_task_acknowledgements", "internship_artifacts",
                "internship_artifact_versions", "internship_artifact_submissions",
                "internship_artifact_reviews", "internship_artifact_activity",
            ):
                self.assertIsNotNone(db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone())
            db.execute("INSERT INTO tutor_accounts VALUES ('learner_a')")
            db.execute("INSERT INTO internship_instances VALUES ('vi_1')")
            db.execute("INSERT INTO internship_tasks VALUES ('vi_1','task_1','in_progress')")
            db.execute("INSERT INTO tutor_objects VALUES ('obj_1')")
            db.execute("INSERT INTO tutor_objects VALUES ('obj_2')")
            db.execute("""INSERT INTO internship_artifacts(
                id,internship_id,task_id,deliverable_type,artifact_type,title,status,current_version_number,
                created_at,updated_at,create_request_id
            ) VALUES ('art_1','vi_1','task_1','memo','memo','Memo','draft',0,1,1,'create_1')""")
            base = (
                "INSERT INTO internship_artifact_versions("
                "id,artifact_id,internship_id,task_id,version_number,object_id,original_filename,content_type,"
                "size_bytes,sha256,source_type,request_id,created_at,created_by"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            )
            db.execute(base, ("ver_1","art_1","vi_1","task_1",1,"obj_1","Memo.md","text/markdown",10,"a"*64,"text","ver_req_1",2,"learner_a"))
            db.execute(base, ("ver_2","art_1","vi_1","task_1",2,"obj_2","Memo.md","text/markdown",12,"b"*64,"text","ver_req_2",3,"learner_a"))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(base, ("ver_dup","art_1","vi_1","task_1",2,"obj_x","Memo.md","text/markdown",12,"c"*64,"text","ver_req_3",4,"learner_a"))
            db.execute("""INSERT INTO internship_artifact_submissions(
                id,artifact_id,artifact_version_id,internship_id,task_id,submission_number,request_id,submitted_at,status
            ) VALUES ('sub_1','art_1','ver_1','vi_1','task_1',1,'sub_req_1',4,'changes_requested')""")
            db.execute("""INSERT INTO internship_artifact_submissions(
                id,artifact_id,artifact_version_id,internship_id,task_id,submission_number,prior_submission_id,request_id,submitted_at,status
            ) VALUES ('sub_2','art_1','ver_2','vi_1','task_1',2,'sub_1','sub_req_2',5,'submitted')""")
            self.assertEqual(db.execute(
                "SELECT artifact_version_id FROM internship_artifact_submissions ORDER BY submission_number"
            ).fetchall(), [("ver_1",),("ver_2",)])
            db.close()

    def test_worker_security_and_integrity_contracts_are_explicit(self):
        worker = WORKER.read_text()
        required = (
            "crypto.subtle.digest('SHA-256'", "owner_kind = ? AND o.owner_id = ?",
            "TUTOR_FILES.delete(key)", "private, no-store", "content-disposition",
            "PHASE5_MAX_FILE_BYTES", "DANGEROUS_EXT", "artifact-version",
            "invalid_actor_override", "task_ready_for_completion",
        )
        for marker in required:
            self.assertIn(marker, worker)
        for forbidden in ("r2.dev", "public R2", "competency_level", "rubric_score", "pass_percentage"):
            self.assertNotIn(forbidden, worker)

    def test_router_and_ui_use_typed_actions_not_status_patch(self):
        router = ROUTER.read_text()
        ui = UI.read_text()
        for marker in (
            "/tasks/{task_id}/acknowledge", "/versions/text", "/versions/upload",
            "/artifacts/{artifact_id}/submit", "/submissions/{submission_id}/review",
            "invoke_workflow_review", "ScenarioStateService().transition_task",
        ):
            self.assertIn(marker, router)
        for forbidden in ("OpenAI(", "Anthropic(", "Gemini(", "competency_passport", '"status": "accepted"'):
            self.assertNotIn(forbidden, router)
        for marker in (
            "Acknowledge assignment", "Save draft", "Submit Version ", "Upload file",
            "Version and submission history", "Create draft", 'type="file"',
        ):
            self.assertIn(marker, ui)
        self.assertNotIn("<table", ui)
        self.assertNotIn("100% competency", ui)

    def test_migration_has_no_phase6_or_phase7_fields(self):
        sql = MIGRATION.read_text().lower()
        for forbidden in ("competency_level", "evidence_strength", "rubric_score", "pass_percentage", "passport"):
            self.assertNotIn(forbidden, sql)


if __name__ == "__main__":
    unittest.main()
