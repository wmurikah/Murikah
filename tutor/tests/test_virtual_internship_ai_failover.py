from pathlib import Path
import asyncio
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
sys.path.insert(0,str(ROOT/"tests"))
from virtual_internship.ai.orchestrator import AIOrchestrationError, SAFE_MESSAGES, VirtualInternshipAIOrchestrator
from virtual_internship.ai.roles import ROLE_POLICIES, RolePolicy, VirtualInternshipModelRole
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

    async def test_role_timeouts_are_hard_bounded_with_short_test_policies(self):
        service=FakeStateService(); sink=AuditSink()
        originals=dict(ROLE_POLICIES)
        try:
            ROLE_POLICIES[VirtualInternshipModelRole.ACTOR]=RolePolicy(VirtualInternshipModelRole.ACTOR,500,0.005,0.02,1,1,False,1)
            actor=VirtualInternshipAIOrchestrator(
                service,candidate_resolver=lambda *_a,**_k:[candidate()],
                stream_factory=lambda *_a,**_k:FakeStream(["late"],delay=0.02),audit_recorder=sink,
            )
            with self.assertRaises(AIOrchestrationError) as cm:
                [i async for i in actor.stream_actor(owner_actor_id="learner_a",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Hello")]
            self.assertEqual(cm.exception.code,"provider_timeout")

            ROLE_POLICIES[VirtualInternshipModelRole.MENTOR]=RolePolicy(VirtualInternshipModelRole.MENTOR,1200,0.005,0.02,1,1,False,1)
            mentor=VirtualInternshipAIOrchestrator(
                service,candidate_resolver=lambda *_a,**_k:[candidate()],
                stream_factory=lambda *_a,**_k:FakeStream(["late"],delay=0.02),audit_recorder=sink,
            )
            with self.assertRaises(AIOrchestrationError) as cm:
                [i async for i in mentor.stream_mentor(owner_actor_id="learner_a",internship_id="vi_1",learner_question="Help",assistance_level=1)]
            self.assertEqual(cm.exception.code,"provider_timeout")

            for role, invoke in (
                (VirtualInternshipModelRole.ASSESSOR, "assessor"),
                (VirtualInternshipModelRole.SCENARIO_DIRECTOR, "director"),
            ):
                ROLE_POLICIES[role]=RolePolicy(role,800,0.0,0.005,1,1,True,1,1)
                orch=VirtualInternshipAIOrchestrator(
                    service,candidate_resolver=lambda *_a,**_k:[candidate()],
                    stream_factory=lambda *_a,**_k:FakeStream(["{}"],delay=0.02),audit_recorder=sink,
                )
                with self.assertRaises(AIOrchestrationError) as cm:
                    if invoke=="assessor":
                        await orch.invoke_assessor(
                            owner_actor_id="learner_a",internship_id="vi_1",task_id="task_one",
                            criteria=[{"criterion_id":"c1"}],evidence=[{"evidence_ref":"e1"}],assistance_level=0,
                        )
                    else:
                        await orch.invoke_scenario_director(owner_actor_id="learner_a",internship_id="vi_1")
                self.assertEqual(cm.exception.code,"provider_timeout")
        finally:
            ROLE_POLICIES.clear(); ROLE_POLICIES.update(originals)

    async def test_actor_total_timeout_closes_selected_stream(self):
        service=FakeStateService(); sink=AuditSink()
        original=ROLE_POLICIES[VirtualInternshipModelRole.ACTOR]
        try:
            ROLE_POLICIES[VirtualInternshipModelRole.ACTOR]=RolePolicy(VirtualInternshipModelRole.ACTOR,500,0.01,0.008,1,1,False,1)
            stream=FakeStream(["first","late"],delays=[0,0.02])
            orch=VirtualInternshipAIOrchestrator(
                service,candidate_resolver=lambda *_a,**_k:[candidate()],
                stream_factory=lambda *_a,**_k:stream,audit_recorder=sink,
            )
            items=[i async for i in orch.stream_actor(owner_actor_id="learner_a",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Hello")]
            self.assertEqual(items[-1]["type"],"error")
            self.assertEqual(items[-1]["metadata"]["error_code"],"provider_timeout")
            self.assertTrue(stream.closed)
        finally:
            ROLE_POLICIES[VirtualInternshipModelRole.ACTOR]=original


if __name__=="__main__": unittest.main()
