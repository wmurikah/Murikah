from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "railway"))
sys.path.insert(0, str(ROOT / "tests"))

from virtual_internship.ai.orchestrator import AIOrchestrationError, SAFE_MESSAGES, VirtualInternshipAIOrchestrator
from virtual_internship.ai.roles import VirtualInternshipModelRole
from virtual_internship_ai_fakes import AuditSink, FakeStateService, FakeStream, candidate


class Phase5WorkflowReviewAITests(unittest.IsolatedAsyncioTestCase):
    async def test_workflow_review_reuses_phase3_provider_and_audits_schema(self):
        service = FakeStateService()
        sink = AuditSink()
        payload = {
            "schema_version": 1,
            "decision": "changes_requested",
            "feedback": "Reconcile the difference before resubmitting.",
            "requested_changes": ["Tie the balance to the source evidence."],
        }
        streams = []

        def factory(*_args, **_kwargs):
            stream = FakeStream([json.dumps(payload)])
            streams.append(stream)
            return stream

        orch = VirtualInternshipAIOrchestrator(
            service,
            candidate_resolver=lambda *_args, **_kwargs: [candidate()],
            stream_factory=factory,
            audit_recorder=sink,
        )
        result, metadata = await orch.invoke_workflow_review(
            owner_actor_id="learner_a",
            internship_id="vi_1",
            task_id="task_one",
            reviewer_actor_id="actor_supervisor",
            task={
                "title": "Review background",
                "brief": "Prepare a concise work product.",
                "business_context": "A variance requires review.",
                "learner_objective": "Document the workflow response.",
            },
            artifact={
                "artifact_id": "art_1",
                "artifact_version_id": "ver_1",
                "deliverable_type": "memo",
                "title": "Variance memo",
                "original_filename": "Variance memo.md",
                "content_type": "text/markdown",
                "content": "Learner work content.",
            },
            prior_reviews=[],
        )
        self.assertEqual(result["decision"], "changes_requested")
        self.assertEqual(metadata["model_role"], "workflow_review")
        self.assertEqual(metadata["output_schema_version"], 1)
        self.assertTrue(all(stream.closed for stream in streams))
        self.assertEqual(sink.rows[-1][2]["model_role"], "workflow_review")
        dumped = json.dumps(result).lower()
        for forbidden in ("score", "competency", "passport", "final_rating", "internship_passed"):
            self.assertNotIn(forbidden, dumped)

    async def test_malformed_workflow_review_fails_closed(self):
        service = FakeStateService()
        sink = AuditSink()
        malformed = {
            "schema_version": 1,
            "decision": "accepted",
            "feedback": "Looks fine.",
            "requested_changes": [],
            "score": 95,
        }
        orch = VirtualInternshipAIOrchestrator(
            service,
            candidate_resolver=lambda *_args, **_kwargs: [candidate()],
            stream_factory=lambda *_args, **_kwargs: FakeStream([json.dumps(malformed)]),
            audit_recorder=sink,
        )
        with self.assertRaises(AIOrchestrationError) as cm:
            await orch.invoke_workflow_review(
                owner_actor_id="learner_a",
                internship_id="vi_1",
                task_id="task_one",
                reviewer_actor_id="actor_supervisor",
                task={"title": "Review background"},
                artifact={
                    "artifact_id": "art_1",
                    "artifact_version_id": "ver_1",
                    "deliverable_type": "memo",
                    "content": "Learner work.",
                },
            )
        self.assertEqual(
            str(cm.exception),
            SAFE_MESSAGES[VirtualInternshipModelRole.WORKFLOW_REVIEW],
        )
        self.assertTrue(all(row[2]["status"] == "failed" for row in sink.rows))

    async def test_foreign_learner_fails_before_provider_resolution(self):
        service = FakeStateService(owner="learner_a")
        called = False

        def resolver(*_args, **_kwargs):
            nonlocal called
            called = True
            return [candidate()]

        orch = VirtualInternshipAIOrchestrator(service, candidate_resolver=resolver)
        with self.assertRaises(RuntimeError):
            await orch.invoke_workflow_review(
                owner_actor_id="learner_b",
                internship_id="vi_1",
                task_id="task_one",
                reviewer_actor_id="actor_supervisor",
                task={"title": "Review background"},
                artifact={
                    "artifact_id": "art_1",
                    "artifact_version_id": "ver_1",
                    "deliverable_type": "memo",
                    "content": "Learner work.",
                },
            )
        self.assertFalse(called)


if __name__ == "__main__":
    unittest.main()
