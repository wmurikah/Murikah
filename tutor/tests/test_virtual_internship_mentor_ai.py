from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
sys.path.insert(0,str(ROOT/"tests"))
from virtual_internship.ai.context import build_actor_context, build_mentor_context
from virtual_internship.ai.outputs import StructuredOutputError, validate_assistance_level
from virtual_internship.ai.orchestrator import VirtualInternshipAIOrchestrator
from virtual_internship_ai_fakes import AuditSink, FakeStateService, FakeStream, candidate


class MentorAITests(unittest.IsolatedAsyncioTestCase):
    def test_assistance_level_is_strictly_zero_through_five(self):
        for value in range(6): self.assertEqual(validate_assistance_level(value),value)
        for value in (-1,6,True,"2"):
            with self.assertRaises(StructuredOutputError): validate_assistance_level(value)

    def test_mentor_uses_learner_view_not_actor_private_view(self):
        service=FakeStateService()
        ctx=build_mentor_context(
            service,account_actor_id="learner_a",internship_id="vi_1",
            learner_question="Explain the control concept.",assistance_level=2,task_id="task_one",
            conversation=[{"role":"user","content":"Prior private coaching"}],
        )
        self.assertEqual({f["fact_id"] for f in ctx["learner_visible_facts"]},{"fact_public"})
        self.assertNotIn("fact_team",str(ctx))
        actor_ctx=build_actor_context(
            service,account_actor_id="learner_a",internship_id="vi_1",
            scenario_actor_id="actor_supervisor",learner_message="Status?",conversation=[]
        )
        self.assertNotIn("Prior private coaching",str(actor_ctx))

    async def test_mentor_stream_metadata_and_no_state_mutation(self):
        service=FakeStateService(); sink=AuditSink(); c1=candidate()
        orch=VirtualInternshipAIOrchestrator(
            service,candidate_resolver=lambda *_a,**_k:[c1],
            stream_factory=lambda *_a,**_k:FakeStream(["Think about ","the objective first."]),
            audit_recorder=sink,
        )
        items=[i async for i in orch.stream_mentor(
            owner_actor_id="learner_a",internship_id="vi_1",
            learner_question="Can you solve this for me?",assistance_level=2,task_id="task_one"
        )]
        self.assertEqual(items[-1]["metadata"]["assistance_level"],2)
        self.assertEqual(items[-1]["metadata"]["model_role"],"mentor")
        self.assertEqual(service.mutations,[])


if __name__=="__main__": unittest.main()
