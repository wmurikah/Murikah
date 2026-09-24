from __future__ import annotations
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.workspace import VirtualInternshipWorkspaceService

MIGRATION=ROOT/"cloudflare/migrations/0010_virtual_internship_phase4_workspace.sql"
WORKER=ROOT/"cloudflare/src/virtual_internship_phase4.ts"
ROUTER=ROOT/"railway/murikah_virtual_internship.py"


class FakePersistence:
    def __init__(self, owner="learner_a", status="active"):
        self.owner=owner; self.status=status
    def _own(self, actor):
        if actor != self.owner: raise RuntimeError("HTTP 404: internship_not_found")
    def internship_ui_current(self, actor):
        self._own(actor); return {"internship_id":"vi_1"}
    def internship_ui_start_options(self, actor):
        self._own(actor); return {"options":[]}
    def internship_status(self, actor, internship):
        self._own(actor)
        if internship != "vi_1": raise RuntimeError("HTTP 404: internship_not_found")
        return {"internship":{
            "internship_id":"vi_1","status":self.status,"lifecycle_stage":"started",
            "scenario_pack":{"title":"Audit Demo","role_title":"Audit Intern"},
            "scenario_version":{"version":1},"qualifying":False,
            "started_at":1000,"target_end_at":1000+90*86400,"current_server_time":1000+8*86400,
            "minimum_duration_days":90,"elapsed_days":8,"stopped_at":1500 if self.status=="stopped" else 0,
        }}
    def internship_ui_threads(self, actor, internship):
        self._own(actor)
        return {"threads":[
            {"id":"vit_1","thread_kind":"workplace","scenario_actor_id":"actor_supervisor","title":"Lina",
             "related_task_id":"task_visible","last_body":"Please review the brief.","last_sender_type":"actor",
             "last_message_at":1400,"message_count":2}
        ]}
    def internship_ui_reflections(self, actor, internship):
        self._own(actor); return {"reflections":[{"id":"vir_1","period_key":"week-2","content":"I checked assumptions.","created_at":1300,"updated_at":1300}]}


class FakeState:
    def learner_view(self, actor, internship):
        if actor!="learner_a": raise RuntimeError("HTTP 404")
        return {"view":{
            "scenario_version_id":"sv_1",
            "facts":[{"fact_id":"fact_visible","value":"Monthly cycle counts are required."}],
            "tasks":[
                {"task_id":"task_visible","title":"Visible task","category":"review","status":"available","due_at":2000},
                {"task_id":"task_hidden","title":"Hidden future task","category":"review","status":"locked","due_at":3000},
            ],
            "fired_events":[{"event_id":"event_visible","fired_at":1250,"audit_label":"Learner visible update"}],
        }}
    def definition(self, actor, internship):
        return {"definition":{
            "manifest":{"title":"Audit Demo","role_title":"Audit Intern","classification":"demo","expected_workload_band":"standard","scenario_version":1},
            "company":{"name":"Meridian","fictional":True,"sector":"Energy","country_region":"Fictional region","description":"Demo company",
                       "products_services":["Service"],"departments":[{"id":"dept_audit","name":"Audit"}],"systems":["ERP"],
                       "process_references":["Process"],"communication_norms":["Be concise"],"work_calendar":{"timezone_label":"office","work_days":["monday"],"notes":""}},
            "facts":[
                {"id":"fact_visible","key":"policy","source":"policy_manual"},
                {"id":"fact_hidden","key":"answer_key","source":"sealed_note"},
            ],
            "actors":[
                {"actor_id":"actor_supervisor","name":"Lina","actor_class":"supervisor","job_title":"Audit Supervisor","department_id":"dept_audit",
                 "reports_to_actor_id":None,"learner_relationship":"direct supervisor","active":True,
                 "goals":["PRIVATE GOAL"],"knowledge_fact_ids":["fact_hidden"]},
                {"actor_id":"actor_hidden","name":"Hidden Person","actor_class":"executive","job_title":"Secret","department_id":"dept_exec",
                 "reports_to_actor_id":None,"learner_relationship":"unknown","active":True,"knowledge_fact_ids":["fact_hidden"]},
            ],
            "tasks":[
                {"task_id":"task_visible","title":"Review process","category":"review","assigned_by_actor_id":"actor_supervisor",
                 "business_context":"Context","learner_objective":"Objective","brief":"Brief","dependencies":[],"expected_effort":"2h",
                 "difficulty":"introductory","allowed_tools":["notes"],"allowed_mentor_support":"light_coaching",
                 "stakeholder_actor_ids":["actor_supervisor"],"deliverable_types":["memo"],"completion_criteria":{"description":"HIDDEN CRITERIA"}},
                {"task_id":"task_hidden","title":"Secret future assignment","category":"review","assigned_by_actor_id":"actor_hidden",
                 "business_context":"HIDDEN BUSINESS","learner_objective":"HIDDEN OBJECTIVE","brief":"HIDDEN BRIEF","dependencies":[],
                 "expected_effort":"2h","difficulty":"advanced","allowed_tools":[],"allowed_mentor_support":"none",
                 "stakeholder_actor_ids":["actor_hidden"],"deliverable_types":[]},
            ],
            "events":[{"event_id":"event_visible","event_type":"workplace_update","actor_ids":["actor_supervisor"],"audit_label":"Visible update","learning_objective":"Learn"}],
            "decisions":[],
        }}


class Phase4BackendTests(unittest.TestCase):
    def test_workspace_filters_hidden_state_and_locked_tasks(self):
        service=VirtualInternshipWorkspaceService(FakePersistence(),FakeState())
        workspace=service.workspace("learner_a","vi_1")
        dumped=json.dumps(workspace)
        self.assertEqual(workspace["state"],"active")
        self.assertEqual([t["task_id"] for t in workspace["tasks"]],["task_visible"])
        self.assertEqual([p["actor_id"] for p in workspace["people"]],["actor_supervisor"])
        self.assertEqual(workspace["documents"][0]["document_id"],"fact:fact_visible")
        for forbidden in ("fact_hidden","Hidden Person","PRIVATE GOAL","HIDDEN CRITERIA","Secret future assignment","HIDDEN BUSINESS"):
            self.assertNotIn(forbidden,dumped)

    def test_dashboard_is_deterministic_and_model_free(self):
        service=VirtualInternshipWorkspaceService(FakePersistence(),FakeState())
        workspace=service.workspace("learner_a","vi_1")
        self.assertEqual(workspace["internship"]["current_day"],9)
        self.assertEqual(workspace["internship"]["current_week"],2)
        self.assertEqual(workspace["overview"]["active_task_count"],1)
        self.assertNotIn("score",json.dumps(workspace).lower())
        source=(ROOT/"railway/virtual_internship/workspace.py").read_text()
        self.assertNotIn("VirtualInternshipAIOrchestrator",source)
        self.assertNotIn("provider_stream",source)

    def test_stopped_internship_is_read_only_state(self):
        workspace=VirtualInternshipWorkspaceService(FakePersistence(status="stopped"),FakeState()).workspace("learner_a","vi_1")
        self.assertEqual(workspace["state"],"stopped")
        self.assertEqual(workspace["internship"]["status"],"stopped")
        self.assertGreater(workspace["internship"]["stopped_at"],0)

    def test_foreign_learner_access_is_rejected_before_view_build(self):
        service=VirtualInternshipWorkspaceService(FakePersistence(owner="learner_a"),FakeState())
        with self.assertRaises(RuntimeError):
            service.workspace("learner_b","vi_1")

    def test_phase4_migration_has_only_ui_records_and_idempotency(self):
        sql=MIGRATION.read_text()
        for table in ("internship_message_threads","internship_messages","internship_reflections"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}",sql)
        self.assertIn("UNIQUE (internship_id, request_id)",sql)
        self.assertIn("UNIQUE (internship_id, period_key)",sql)
        for forbidden in ("competency_evidence","competency_passports","internship_artifacts","rubric_score"):
            self.assertNotIn(forbidden,sql)

    def test_message_and_reflection_constraints_survive_restart(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite3") as handle:
            db=sqlite3.connect(handle.name)
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript("""
              CREATE TABLE persistence_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
              CREATE TABLE internship_instances(id TEXT PRIMARY KEY) STRICT;
            """)
            db.executescript(MIGRATION.read_text())
            db.execute("INSERT INTO internship_instances(id) VALUES ('vi_1')")
            db.execute("INSERT INTO internship_message_threads VALUES ('vit_1','vi_1','mentor','mentor','','','Murikah Mentor',1,1)")
            db.execute("INSERT INTO internship_messages VALUES ('vim_1','vi_1','vit_1','learner','','Help me','','','','req_1',1)")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO internship_messages VALUES ('vim_2','vi_1','vit_1','learner','','Again','','','','req_1',2)")
            db.execute("INSERT INTO internship_reflections VALUES ('vir_1','vi_1','week-1',1,'Reflection',1,1)")
            db.commit();db.close()
            fresh=sqlite3.connect(handle.name)
            self.assertEqual(fresh.execute("SELECT body FROM internship_messages WHERE id='vim_1'").fetchone()[0],"Help me")
            self.assertEqual(fresh.execute("SELECT content FROM internship_reflections WHERE id='vir_1'").fetchone()[0],"Reflection")
            fresh.close()

    def test_worker_and_router_enforce_owner_and_phase3_boundaries(self):
        worker=WORKER.read_text()
        router=ROUTER.read_text()
        self.assertIn("WHERE id = ? AND learner_id = ? LIMIT 1",worker)
        self.assertIn("invalid_workspace_payload",worker)
        self.assertIn("VirtualInternshipAIOrchestrator",router)
        self.assertIn("stream_actor(",router)
        self.assertIn("stream_mentor(",router)
        for forbidden in ("OpenAI(","Anthropic(","Gemini(","NVIDIA(","scenario_patch_state"):
            self.assertNotIn(forbidden,router)

    def test_document_browser_uses_only_learner_revealed_facts(self):
        service=VirtualInternshipWorkspaceService(FakePersistence(),FakeState())
        doc=service.document("learner_a","vi_1","fact:fact_visible")
        self.assertEqual(doc["content"],"Monthly cycle counts are required.")
        with self.assertRaises(LookupError):
            service.document("learner_a","vi_1","fact:fact_hidden")


if __name__=="__main__":
    unittest.main()
