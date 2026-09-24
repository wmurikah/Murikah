import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.assessment.reviews import attach_review_signals,build_review_snapshot,deterministic_review_findings,review_eligibility

class Phase6PerformanceReviewTests(unittest.TestCase):
    def manifest(self):
        return {"classification":"qualifying","minimum_duration_days":90,"review_policy":{
            "midpoint_day":45,"final_review_day":85,"demo_accelerated_midpoint_day":2,"demo_accelerated_final_day":4}}

    def test_midpoint_and_final_use_server_time_policy(self):
        start=1_000_000
        manifest=self.manifest()
        self.assertFalse(review_eligibility(review_type="midpoint",manifest=manifest,started_at=start,now=start+44*86400)["eligible"])
        self.assertTrue(review_eligibility(review_type="midpoint",manifest=manifest,started_at=start,now=start+45*86400)["eligible"])
        self.assertFalse(review_eligibility(review_type="final",manifest=manifest,started_at=start,now=start+85*86400)["eligible"])
        self.assertFalse(review_eligibility(review_type="final",manifest=manifest,started_at=start,now=start+89*86400)["eligible"])
        final=review_eligibility(review_type="final",manifest=manifest,started_at=start,now=start+90*86400)
        self.assertTrue(final["eligible"])
        self.assertEqual(final["required_day"],90)

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

    def test_review_findings_use_authored_scale_not_hardcoded_rating_labels(self):
        rubric={
            "rubric_id":"r1","schema_version":1,"title":"Review","purpose":"Review signals",
            "calculation":{"method":"weighted_average","weight_total":100,"rounding":"half_up_2dp"},
            "rating_levels":[
                {"rating_id":"foundation","label":"Foundation","value":25},
                {"rating_id":"ready","label":"Ready","value":75},
                {"rating_id":"advanced","label":"Advanced","value":100},
            ],
            "criteria":[{
                "criterion_id":"c1","description":"Analysis","evidence_expectations":"Cite work",
                "weight":100,"allowed_rating_ids":["foundation","ready","advanced"],
                "deliverable_types":["memo"],"allow_not_assessed":False,
            }],
        }
        assessment=attach_review_signals({
            "id":"a1","status":"completed","criteria":[
                {"criterion_id":"c1","result_state":"assessed","rating_id":"ready","feedback":"The work ties the variance to source evidence."}
            ],
        },rubric)
        snapshot={"assessments":[assessment],"assistance_events":[]}
        result=deterministic_review_findings(snapshot)
        self.assertEqual(result["strengths"][0]["assessment_id"],"a1")
        self.assertEqual(assessment["criteria"][0]["review_signal"],"strength")
        dumped=str(result).lower()
        self.assertNotIn("internship_completed",dumped)
        self.assertNotIn("passport",dumped)
        source=(ROOT/"railway/virtual_internship/assessment/reviews.py").read_text()
        self.assertNotIn('{"meets", "exceeds"}',source)

    def test_lower_half_of_authored_scale_is_development_signal(self):
        rubric={
            "rubric_id":"r2","schema_version":1,"title":"Review","purpose":"Review signals",
            "calculation":{"method":"weighted_average","weight_total":100,"rounding":"half_up_2dp"},
            "rating_levels":[
                {"rating_id":"foundation","label":"Foundation","value":25},
                {"rating_id":"ready","label":"Ready","value":75},
            ],
            "criteria":[{
                "criterion_id":"c1","description":"Analysis","evidence_expectations":"Cite work",
                "weight":100,"allowed_rating_ids":["foundation","ready"],
                "deliverable_types":["memo"],"allow_not_assessed":False,
            }],
        }
        assessment=attach_review_signals({
            "id":"a2","status":"completed","criteria":[
                {"criterion_id":"c1","result_state":"assessed","rating_id":"foundation","feedback":"The work omits reconciliation of the largest item."}
            ],
        },rubric)
        result=deterministic_review_findings({"assessments":[assessment],"assistance_events":[]})
        self.assertEqual(result["development_areas"][0]["assessment_id"],"a2")
        self.assertEqual(assessment["criteria"][0]["review_signal"],"development")

if __name__=="__main__":unittest.main()
