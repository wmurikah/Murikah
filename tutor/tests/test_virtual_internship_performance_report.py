import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORKER=(ROOT/"cloudflare/src/virtual_internship_phase9.ts").read_text()
ROUTER=(ROOT/"railway/murikah_virtual_internship.py").read_text()

class Phase9PerformanceReportTests(unittest.TestCase):
    def test_report_is_anchored_to_phase8_completion_record_and_snapshot(self):
        self.assertIn("FROM completion_records c",WORKER)
        self.assertIn("completion_snapshot_integrity_failed",WORKER)
        self.assertIn("gate_snapshot_json",WORKER)
        self.assertIn("evidence_refs_json",WORKER)
        self.assertIn("source_snapshot_hash",WORKER)

    def test_report_uses_existing_phase5_phase6_phase7_lineage(self):
        for marker in (
            "internship_artifacts a",
            "internship_artifact_submissions",
            "internship_artifact_versions",
            "internship_performance_reviews",
            "competency_evidence e",
            "internship_assessment_criteria",
            "internship_reflections","reference_type: 'performance_review'",
        ):
            self.assertIn(marker,WORKER)
        self.assertIn("current_level",WORKER)
        self.assertIn("current_evidence_strength",WORKER)

    def test_report_has_required_professional_fields(self):
        for marker in (
            "learner_name_snapshot","internship_title","simulated_organization",
            "total_duration_days","expected_workload_band","role_summary","key_assignments",
            "work_products_completed","performance_review","competency_summary","strengths",
            "development_areas","evidence_highlights","assistance_independence_context",
            "midpoint_to_final_improvement","supervisor_style_narrative",
            "learner_reflection_summary","limitations","evidence_references",
        ):
            self.assertIn(marker,WORKER)

    def test_generation_has_no_model_dependency(self):
        lower=WORKER.lower()
        for provider in ("openai","claude","gemini","qwen","nvidia"):
            self.assertNotIn(provider,lower)
        self.assertNotIn("invoke_workflow",WORKER)
        self.assertIn("buildReportSource",WORKER)

    def test_name_comes_from_authenticated_server_personalization_contract(self):
        self.assertIn("personalization_for_actor(actor_id,username)",ROUTER)
        self.assertIn("learner_name_snapshot=learner_name",ROUTER)
        self.assertIn("is not a legal-identity verification",WORKER)

if __name__=="__main__":
    unittest.main()
