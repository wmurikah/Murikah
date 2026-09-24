import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.assessment.rubrics import (
    RUBRIC_CALCULATION_VERSION, RubricError, calculate_aggregate, rubric_hash, validate_rubric,
)
from virtual_internship.validator import validate_all

def rubric():
    return {
        "rubric_id":"rubric_demo_v1","schema_version":1,"title":"Demo","purpose":"Evidence based",
        "calculation":{"method":"weighted_average","weight_total":100,"rounding":"half_up_2dp"},
        "rating_levels":[
            {"rating_id":"developing","label":"Developing","value":50},
            {"rating_id":"meets","label":"Meets","value":75},
            {"rating_id":"exceeds","label":"Exceeds","value":100},
        ],
        "criteria":[
            {"criterion_id":"analysis","description":"Analysis","evidence_expectations":"Cite analysis","weight":67,
             "allowed_rating_ids":["developing","meets","exceeds"],"deliverable_types":["memo"],"allow_not_assessed":False},
            {"criterion_id":"clarity","description":"Clarity","evidence_expectations":"Cite clarity","weight":33,
             "allowed_rating_ids":["developing","meets","exceeds"],"deliverable_types":["memo"],"allow_not_assessed":False},
        ],
    }

class Phase6RubricTests(unittest.TestCase):
    def test_committed_v2_rubrics_validate_through_phase2_schema(self):
        rows=validate_all()
        self.assertEqual(len(rows),6)

    def test_valid_rubric_is_stable_and_versioned(self):
        value=validate_rubric(rubric())
        self.assertEqual(value["rubric_id"],"rubric_demo_v1")
        self.assertEqual(len(rubric_hash(value)),64)
        self.assertEqual(RUBRIC_CALCULATION_VERSION,"phase6-weighted-v1")

    def test_negative_weight_and_invalid_weight_total_are_rejected(self):
        value=rubric();value["criteria"][0]["weight"]=-1;value["criteria"][1]["weight"]=101
        with self.assertRaises(RubricError):validate_rubric(value)
        value=rubric();value["criteria"][0]["weight"]=60
        with self.assertRaises(RubricError):validate_rubric(value)

    def test_non_aggregating_rubric_may_omit_optional_weights(self):
        value=rubric()
        value["calculation"]["method"]="none"
        for criterion in value["criteria"]:
            criterion.pop("weight")
        normalized=validate_rubric(value)
        self.assertTrue(all("weight" not in criterion for criterion in normalized["criteria"]))
        self.assertIsNone(calculate_aggregate(normalized,[]))

    def test_weighted_rubric_rejects_missing_weight(self):
        value=rubric();value["criteria"][0].pop("weight")
        with self.assertRaises(RubricError):validate_rubric(value)

    def test_duplicate_criterion_id_is_rejected(self):
        value=rubric();value["criteria"][1]["criterion_id"]="analysis"
        with self.assertRaises(RubricError):validate_rubric(value)

    def test_unknown_rating_reference_rejected(self):
        value=rubric();value["criteria"][0]["allowed_rating_ids"]=["invented"]
        with self.assertRaises(RubricError):validate_rubric(value)

    def test_deterministic_weighted_calculation_and_rounding(self):
        result=calculate_aggregate(rubric(),[
            {"criterion_id":"analysis","result_state":"assessed","rating_id":"meets"},
            {"criterion_id":"clarity","result_state":"assessed","rating_id":"exceeds"},
        ])
        self.assertEqual(result,"83.25")

    def test_not_assessed_has_no_misleading_numeric_total(self):
        result=calculate_aggregate(rubric(),[
            {"criterion_id":"analysis","result_state":"not_assessed","rating_id":""},
            {"criterion_id":"clarity","result_state":"assessed","rating_id":"meets"},
        ])
        self.assertIsNone(result)

if __name__=="__main__":unittest.main()
