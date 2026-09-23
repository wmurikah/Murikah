from pathlib import Path
import json
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
sys.path.insert(0,str(ROOT/"tests"))
from virtual_internship.ai.orchestrator import AIOrchestrationError, VirtualInternshipAIOrchestrator
from virtual_internship.ai.outputs import StructuredOutputError, validate_director_output
from virtual_internship_ai_fakes import AuditSink, FakeStateService, FakeStream, candidate


class StructuredAITests(unittest.IsolatedAsyncioTestCase):
    async def test_assessor_accepts_strict_test_schema_without_writing_evidence(self):
        service=FakeStateService(); sink=AuditSink(); c1=candidate()
        payload={"schema_version":1,"summary":"Evidence supports the criterion.","criteria":[{"criterion_id":"criterion_1","result":"met","evidence_refs":["evidence_1"]}],"limitations":[]}
        orch=VirtualInternshipAIOrchestrator(
            service,candidate_resolver=lambda *_a,**_k:[c1],
            stream_factory=lambda *_a,**_k:FakeStream([json.dumps(payload)]),audit_recorder=sink,
        )
        result,meta=await orch.invoke_assessor(
            owner_actor_id="learner_a",internship_id="vi_1",task_id="task_one",
            criteria=[{"criterion_id":"criterion_1","description":"Uses evidence"}],
            evidence=[{"evidence_ref":"evidence_1","summary":"Test evidence"}],assistance_level=1,
        )
        self.assertEqual(result["criteria"][0]["result"],"met")
        self.assertEqual(meta["output_schema_version"],1)
        self.assertEqual(service.mutations,[])


    async def test_structured_role_discards_hidden_thinking_chunks_before_json_validation(self):
        service=FakeStateService(); sink=AuditSink(); c1=candidate()
        valid={"schema_version":1,"proposal_type":"select_authored_event","event_id":"event_known","rationale_summary":"Use the authored event."}
        orch=VirtualInternshipAIOrchestrator(
            service,candidate_resolver=lambda *_a,**_k:[c1],
            stream_factory=lambda *_a,**_k:FakeStream(["<think>","private reasoning","</think>",json.dumps(valid)]),
            audit_recorder=sink,
        )
        result,meta=await orch.invoke_scenario_director(owner_actor_id="learner_a",internship_id="vi_1")
        self.assertEqual(result["event_id"],"event_known")
        self.assertNotIn("private reasoning",str(result))
        self.assertNotIn("private reasoning",str(meta))

    async def test_structured_malformed_primary_repairs_once_via_fallback(self):
        service=FakeStateService(); sink=AuditSink(); candidates=[candidate(model_id="m1"),candidate(model_id="m2",model="vendor/m2")]
        calls=[]
        def factory(c,*_a,**_k):
            calls.append(c.model_id)
            if c.model_id=="m1": return FakeStream(["not-json"])
            valid={"schema_version":1,"proposal_type":"choose_authored_option","decision_id":"decision_escalation","option_id":"escalate","rationale_summary":"Authored option fits."}
            return FakeStream([json.dumps(valid)])
        orch=VirtualInternshipAIOrchestrator(service,candidate_resolver=lambda *_a,**_k:candidates,stream_factory=factory,audit_recorder=sink)
        result,meta=await orch.invoke_scenario_director(owner_actor_id="learner_a",internship_id="vi_1")
        self.assertEqual(result["option_id"],"escalate")
        self.assertEqual(calls,["m1","m2"])
        self.assertEqual(meta["fallback_count"],1)
        self.assertEqual(meta["decision_id"],"decision_escalation")
        self.assertEqual(service.mutations,[])

    def test_director_rejects_unknown_event_and_arbitrary_patch(self):
        with self.assertRaises(StructuredOutputError):
            validate_director_output(
                {"schema_version":1,"proposal_type":"select_authored_event","event_id":"unknown","rationale_summary":""},
                allowed_event_ids={"event_known"},allowed_decisions={},
            )
        with self.assertRaises(StructuredOutputError):
            validate_director_output(
                {"schema_version":1,"proposal_type":"select_authored_event","event_id":"event_known","rationale_summary":"","patch_state":{"anything":"anything"}},
                allowed_event_ids={"event_known"},allowed_decisions={},
            )

    async def test_director_malformed_outputs_fail_closed_without_state_mutation(self):
        service=FakeStateService(); sink=AuditSink()
        candidates=[candidate(model_id="m1"),candidate(model_id="m2",model="vendor/m2")]
        orch=VirtualInternshipAIOrchestrator(
            service,candidate_resolver=lambda *_a,**_k:candidates,
            stream_factory=lambda *_a,**_k:FakeStream(['{"schema_version":1,"proposal_type":"select_authored_event","event_id":"unknown","rationale_summary":""}']),
            audit_recorder=sink,
        )
        with self.assertRaises(AIOrchestrationError):
            await orch.invoke_scenario_director(owner_actor_id="learner_a",internship_id="vi_1")
        self.assertEqual(service.mutations,[])
        self.assertEqual(sink.rows[-1][2]["status"],"failed")
        self.assertEqual(sink.rows[-1][2]["error_code"],"schema_validation_failed")

    def test_director_application_uses_only_phase2_typed_operations(self):
        service=FakeStateService()
        orch=VirtualInternshipAIOrchestrator(service,candidate_resolver=lambda *_a,**_k:[])
        out=orch.apply_director_proposal(
            owner_actor_id="learner_a",internship_id="vi_1",
            proposal={"proposal_type":"choose_authored_option","decision_id":"decision_escalation","option_id":"escalate"},
            request_id="req_1",expected_revision=0,
        )
        self.assertEqual(service.mutations,[("decision","decision_escalation","escalate"),("evaluate",)])
        event_out=orch.apply_director_proposal(
            owner_actor_id="learner_a",internship_id="vi_1",
            proposal={"proposal_type":"select_authored_event","event_id":"event_known"},
            request_id="req_2",
        )
        self.assertFalse(event_out["applied"])
        self.assertEqual(event_out["authority"],"phase2_evaluate")


if __name__=="__main__": unittest.main()
