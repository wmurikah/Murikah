import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

from virtual_internship.passport.aggregation import aggregate_competency,PASSPORT_AGGREGATION_RULESET_VERSION

DEFINITION={"recency_policy":{"conflict_window":2,"latest_strong_not_demonstrated_cap":"developing","two_strong_not_demonstrated_cap":"emerging"},"evidence_requirements":{
    "emerging":{"min_records":1,"min_candidate":"developing"},
    "developing":{"min_records":2,"min_candidate":"developing"},
    "applied_with_support":{"min_records":2,"min_candidate":"applied_with_support"},
    "independent":{"min_records":2,"min_candidate":"independent","min_independent":1},
    "advanced":{"min_records":4,"min_candidate":"independent","min_independent":3,"min_task_contexts":2,"min_transfer_contexts":2},
}}

def ev(i,level="developing",internship="vi_1",task="task_1",context="one",created=None,strength="supporting"):
    return {"id":f"ev_{i}","demonstrated_level":level,"internship_id":internship,"task_id":task,
            "transfer_context":{"career_family":"audit","role_family":"audit","scenario_pack_id":"sp",
                                "task_category":"review","domain":"audit","work_context":context},
            "created_at":created if created is not None else i,"evidence_strength":strength}

class Phase7AggregationTests(unittest.TestCase):
    def test_one_record_is_emerging_not_advanced(self):
        result=aggregate_competency(definition=DEFINITION,evidence=[ev(1,"independent")])
        self.assertEqual(result["current_level"],"emerging")
        self.assertEqual(result["aggregation_ruleset_version"],PASSPORT_AGGREGATION_RULESET_VERSION)

    def test_repeated_criteria_same_task_do_not_fake_task_transfer(self):
        rows=[ev(1,"independent"),ev(2,"independent"),ev(3,"independent"),ev(4,"independent")]
        result=aggregate_competency(definition=DEFINITION,evidence=rows)
        self.assertEqual(result["distinct_task_count"],1)
        self.assertNotEqual(result["current_level"],"advanced")

    def test_advanced_requires_repeated_independent_distinct_contexts(self):
        rows=[
            ev(1,"independent","vi_1","task_1","one"),
            ev(2,"independent","vi_1","task_1","one"),
            ev(3,"independent","vi_2","task_2","two"),
            ev(4,"independent","vi_2","task_2","two"),
        ]
        result=aggregate_competency(definition=DEFINITION,evidence=rows)
        self.assertEqual(result["current_level"],"advanced")
        self.assertEqual(result["distinct_task_count"],2)
        self.assertEqual(result["distinct_context_count"],2)

    def test_trend_is_deterministic_and_requires_three_points(self):
        self.assertEqual(aggregate_competency(definition=DEFINITION,evidence=[ev(1),ev(2)])["trend"],"insufficient_evidence")
        stable=[ev(1,"developing"),ev(2,"developing"),ev(3,"developing")]
        self.assertEqual(aggregate_competency(definition=DEFINITION,evidence=stable)["trend"],"stable")
        improving=[ev(1,"developing"),ev(2,"applied_with_support"),ev(3,"independent")]
        self.assertEqual(aggregate_competency(definition=DEFINITION,evidence=improving)["trend"],"improving")
        mixed=[ev(1,"independent"),ev(2,"developing"),ev(3,"independent")]
        self.assertEqual(aggregate_competency(definition=DEFINITION,evidence=mixed)["trend"],"mixed")

    def test_recent_strong_contradictory_evidence_can_downgrade_deterministically(self):
        rows=[
            ev(1,"independent","vi_1","task_1","one",strength="strong"),
            ev(2,"independent","vi_2","task_2","two",strength="strong"),
            ev(3,"independent","vi_3","task_3","three",strength="strong"),
            ev(4,"independent","vi_4","task_4","four",strength="strong"),
            ev(5,"not_demonstrated","vi_5","task_5","five",strength="strong"),
        ]
        self.assertEqual(aggregate_competency(definition=DEFINITION,evidence=rows)["current_level"],"developing")
        rows.append(ev(6,"not_demonstrated","vi_6","task_6","six",strength="strong"))
        self.assertEqual(aggregate_competency(definition=DEFINITION,evidence=rows)["current_level"],"emerging")


    def test_next_level_requirements_count_only_qualifying_evidence(self):
        rows=[
            ev(1,"developing","vi_1","task_1","one"),
            ev(2,"not_demonstrated","vi_2","task_2","two",strength="strong"),
        ]
        result=aggregate_competency(definition=DEFINITION,evidence=rows)
        self.assertEqual(result["current_level"],"emerging")
        missing={row["kind"]:row["count"] for row in result["next_requirements"]}
        self.assertEqual(missing["evidence_records"],1)

    def test_configured_recency_excludes_expired_contribution_without_deleting_history(self):
        definition={**DEFINITION,"recency_policy":{
            **DEFINITION["recency_policy"],"expires_after_days":30,
        }}
        old=ev(1,"independent","vi_1","task_1","one",created=100)
        recent=ev(2,"developing","vi_2","task_2","two",created=3_000_000)
        result=aggregate_competency(
            definition=definition,
            evidence=[old,recent],
            as_of=3_000_000,
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["evidence_count"],1)
        self.assertEqual(result["explanation"]["historical_evidence_records"],2)
        self.assertEqual(result["explanation"]["expired_evidence_records"],1)


    def test_newer_mapping_version_does_not_double_count_same_logical_contribution(self):
        base=ev(1,"independent","vi_1","task_1","one")
        older={**base,"id":"ev_old","assessment_id":"asm_1","criterion_id":"c1","competency_id":"comp_x","mapping_version":1}
        newer={**base,"id":"ev_new","assessment_id":"asm_1","criterion_id":"c1","competency_id":"comp_x","mapping_version":2}
        result=aggregate_competency(definition=DEFINITION,evidence=[older,newer])
        self.assertEqual(result["evidence_count"],1)
        self.assertEqual(result["current_level"],"emerging")

    def test_revoked_evidence_is_excluded(self):
        rows=[ev(1),{**ev(2),"revoked":True}]
        result=aggregate_competency(definition=DEFINITION,evidence=rows)
        self.assertEqual(result["evidence_count"],1)

if __name__=="__main__": unittest.main()
