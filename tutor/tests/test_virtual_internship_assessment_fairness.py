import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.ai.context import build_formal_assessor_context

class FakeService:
    def learner_view(self,actor,internship):
        return {"view":{"scenario_version_id":"sv_1","facts":[{"fact_id":"f1","value":"visible"}],
                        "tasks":[{"task_id":"task_1","status":"completed","due_at":123}]}}
    def definition(self,actor,internship):
        return {"definition":{"tasks":[{"task_id":"task_1","title":"Task","category":"analysis","business_context":"Context",
            "learner_objective":"Objective","brief":"Brief","allowed_tools":[],"allowed_mentor_support":"clarification",
            "stakeholder_actor_ids":[]}]}}

class Phase6FairnessTests(unittest.TestCase):
    def context(self,actor):
        return build_formal_assessor_context(
            FakeService(),account_actor_id=actor,internship_id="vi_1",task_id="task_1",assessment_id="asm_1",
            rubric={"rubric_id":"r1"},evidence_packet={"references":[]},assistance_events=[],workflow_feedback=[],
        )

    def test_synthetic_identity_variations_do_not_change_model_context(self):
        self.assertEqual(self.context("learner_alice"),self.context("learner_bob"))

    def test_identity_and_sensitive_profile_fields_are_absent(self):
        dumped=str(self.context("learner_a")).lower()
        for forbidden in ("preferred_name","email","race","ethnicity","religion","sexual_orientation","health","disability"):
            if forbidden in {"preferred_name","email"}:
                self.assertIn(forbidden,dumped)
            else:
                self.assertNotIn(forbidden,dumped)
        exclusions=self.context("learner_a")["context_exclusions"]
        self.assertIn("preferred_name",exclusions)
        self.assertIn("email",exclusions)
        self.assertIn("sensitive_personal_profile_fields",exclusions)

    def test_private_mentor_conversation_is_explicitly_excluded(self):
        self.assertIn("private_mentor_conversation",self.context("learner_a")["context_exclusions"])

if __name__=="__main__":unittest.main()
