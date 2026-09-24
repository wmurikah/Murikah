import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.ai.context import build_formal_assessor_context
from virtual_internship.ai.prompts import ASSESSOR_SYSTEM_PROMPT
from virtual_internship.assessment.engine import validate_and_calculate_assessment

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
            self.assertNotIn(forbidden,dumped)

    def test_private_mentor_conversation_is_not_supplied(self):
        dumped=str(self.context("learner_a")).lower()
        self.assertNotIn("mentor_conversation",dumped)

    def test_unrelated_writing_polish_does_not_change_deterministic_technical_result(self):
        rubric={
            "rubric_id":"r_technical","schema_version":1,"title":"Technical","purpose":"Technical evidence",
            "calculation":{"method":"weighted_average","weight_total":100,"rounding":"half_up_2dp"},
            "rating_levels":[{"rating_id":"meets","label":"Meets","value":75}],
            "criteria":[{
                "criterion_id":"technical","description":"Technical analysis",
                "evidence_expectations":"Cite the technical conclusion","weight":100,
                "allowed_rating_ids":["meets"],"deliverable_types":["memo"],"allow_not_assessed":False,
            }],
        }
        assessor_output={
            "schema_version":1,"assessment_id":"asm_1",
            "criterion_results":[{
                "criterion_id":"technical","rating":"meets","evidence_refs":["ev_1"],
                "feedback":"The variance calculation is supported by the cited source.","limitation":"",
            }],
            "overall_summary":"Technical criterion assessed.","limitations":[],
        }
        def packet(excerpt):
            return {
                "artifact_id":"art_1","artifact_version_id":"ver_1","submission_id":"sub_1",
                "limitations":[],"references":[{
                    "evidence_ref":"ev_1","artifact_id":"art_1","artifact_version_id":"ver_1",
                    "submission_id":"sub_1","source_kind":"artifact_text",
                    "locator":{"kind":"line_range","start_line":1,"end_line":1},"excerpt":excerpt,
                }],
            }
        polished=validate_and_calculate_assessment(
            assessor_output,assessment_id="asm_1",rubric=rubric,
            evidence_packet=packet("The reconciled variance is 14 units."),
        )
        rough=validate_and_calculate_assessment(
            assessor_output,assessment_id="asm_1",rubric=rubric,
            evidence_packet=packet("variance 14 units reconciled"),
        )
        self.assertEqual(polished["aggregate_numeric"],rough["aggregate_numeric"])
        self.assertEqual(polished["criterion_results"][0]["rating_id"],rough["criterion_results"][0]["rating_id"])
        self.assertIn("Do not penalize writing style under a technical criterion",ASSESSOR_SYSTEM_PROMPT)

if __name__=="__main__":unittest.main()
