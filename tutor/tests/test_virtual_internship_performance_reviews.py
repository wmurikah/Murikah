import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.assessment.reviews import build_review_snapshot,deterministic_review_findings,review_eligibility

class Phase6PerformanceReviewTests(unittest.TestCase):
    def manifest(self):
        return {"classification":"qualifying","minimum_duration_days":90,"review_policy":{
            "midpoint_day":45,"final_review_day":85,"demo_accelerated_midpoint_day":2,"demo_accelerated_final_day":4}}

    def test_midpoint_and_final_use_server_time_policy(self):
        start=1_000_000
        self.assertFalse(review_eligibility(review_type="midpoint",manifest=self.manifest(),started_at=start,now=start+44*86400)["eligible"])
        self.assertTrue(review_eligibility(review_type="midpoint",manifest=self.manifest(),started_at=start,now=start+45*86400)["eligible"])
        self.assertFalse(review_eligibility(review_type="final",manifest=self.manifest(),started_at=start,now=start+2*86400)["eligible"])

    def test_demo_acceleration_is_nonqualifying_policy_only(self):
        manifest=self.manifest();manifest["classification"]="demo"
        start=100
        self.assertTrue(review_eligibility(review_type="midpoint",manifest=manifest,started_at=start,now=start+2*86400)["eligible"])

    def test_snapshot_excludes_records_after_cutoff_and_is_hashed(self):
        snapshot=build_review_snapshot(review_type="midpoint",cutoff_at=100,assessments=[
            {"id":"a1","created_at":90,"status":"completed","criteria":[]},
            {"id":"a2","created_at":110,"status":"completed","criteria":[]},
        ],workflow_reviews=[],reflections=[],assistance_events=[],activity=[])
        self.assertEqual([x["id"] for x in snapshot["assessments"]],["a1"])
        self.assertEqual(len(snapshot["snapshot_hash"]),64)

    def test_snapshot_excludes_undated_records(self):
        snapshot=build_review_snapshot(review_type="midpoint",cutoff_at=100,assessments=[
            {"id":"a1","status":"completed","criteria":[]},
            {"id":"a2","created_at":90,"status":"completed","criteria":[]},
        ],workflow_reviews=[],reflections=[],assistance_events=[],activity=[])
        self.assertEqual([x["id"] for x in snapshot["assessments"]],["a2"])

    def test_review_findings_are_evidence_id_grounded_and_not_completion(self):
        snapshot={"assessments":[{"id":"a1","status":"completed","criteria":[
            {"criterion_id":"c1","result_state":"assessed","rating_id":"meets","feedback":"The work ties the variance to source evidence."}
        ]}],"assistance_events":[]}
        result=deterministic_review_findings(snapshot)
        self.assertEqual(result["strengths"][0]["assessment_id"],"a1")
        dumped=str(result).lower()
        self.assertNotIn("internship_completed",dumped)
        self.assertNotIn("passport",dumped)

if __name__=="__main__":unittest.main()
