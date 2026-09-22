from pathlib import Path
import asyncio
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
sys.path.insert(0,str(ROOT/"tests"))
from virtual_internship.ai.orchestrator import AIOrchestrationError, SAFE_MESSAGES, VirtualInternshipAIOrchestrator
from virtual_internship.ai.roles import VirtualInternshipModelRole
from virtual_internship_ai_fakes import AuditSink, FakeStateService, FakeStream, candidate


class AIFailoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_actor_primary_failure_falls_back_same_role_and_closes_loser(self):
        service=FakeStateService(); sink=AuditSink()
        candidates=[candidate(model_id="m1"),candidate(model_id="m2",model="vendor/m2")]
        streams=[]
        def factory(c,*_a,**_k):
            stream=FakeStream(error=RuntimeError("provider failed")) if c.model_id=="m1" else FakeStream(["Fallback actor reply."])
            streams.append(stream); return stream
        orch=VirtualInternshipAIOrchestrator(service,candidate_resolver=lambda *_a,**_k:candidates,stream_factory=factory,audit_recorder=sink)
        items=[i async for i in orch.stream_actor(owner_actor_id="learner_a",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Status?")]
        self.assertEqual(items[-1]["metadata"]["fallback_count"],1)
        self.assertEqual(items[-1]["metadata"]["model_role"],"actor")
        self.assertTrue(all(s.closed for s in streams))
        self.assertNotIn("secret-never-audited",str(sink.rows))

    async def test_all_providers_fail_with_learner_safe_message(self):
        service=FakeStateService(); sink=AuditSink()
        candidates=[candidate(model_id="m1"),candidate(model_id="m2",model="vendor/m2")]
        orch=VirtualInternshipAIOrchestrator(
            service,candidate_resolver=lambda *_a,**_k:candidates,
            stream_factory=lambda *_a,**_k:FakeStream(error=RuntimeError("HTTP 401 api key invalid")),
            audit_recorder=sink,
        )
        with self.assertRaises(AIOrchestrationError) as cm:
            [i async for i in orch.stream_actor(owner_actor_id="learner_a",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Hello")]
        self.assertEqual(str(cm.exception),SAFE_MESSAGES[VirtualInternshipModelRole.ACTOR])
        self.assertNotIn("401",str(cm.exception))
        self.assertEqual(sink.rows[-1][2]["status"],"failed")

    async def test_cross_learner_ownership_fails_before_provider_resolution(self):
        service=FakeStateService(owner="learner_a"); called=False
        def resolver(*_a,**_k):
            nonlocal called; called=True; return [candidate()]
        orch=VirtualInternshipAIOrchestrator(service,candidate_resolver=resolver)
        with self.assertRaises(RuntimeError):
            [i async for i in orch.stream_actor(owner_actor_id="learner_b",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Hello")]
        self.assertFalse(called)

    async def test_post_first_token_interruption_is_safe_and_audited(self):
        service=FakeStateService(); sink=AuditSink()
        orch=VirtualInternshipAIOrchestrator(
            service,candidate_resolver=lambda *_a,**_k:[candidate()],
            stream_factory=lambda *_a,**_k:FakeStream(["Partial response"],error=RuntimeError("socket reset")),
            audit_recorder=sink,
        )
        items=[i async for i in orch.stream_actor(owner_actor_id="learner_a",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Hello")]
        self.assertEqual(items[-1]["type"],"error")
        self.assertEqual(items[-1]["message"],SAFE_MESSAGES[VirtualInternshipModelRole.ACTOR])
        self.assertEqual(items[-1]["metadata"]["error_code"],"provider_stream_error")


if __name__=="__main__": unittest.main()
