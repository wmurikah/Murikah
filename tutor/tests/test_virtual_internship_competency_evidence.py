import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

from virtual_internship.passport.evidence import derive_evidence_contribution

def assessment(status="completed"):
    return {
        "id":"asm_1","status":status,"artifact_id":"art_1","artifact_version_id":"ver_1",
        "submission_id":"sub_1","limitations":[],
    }

def criterion(rating="meets",refs=True):
    return {
        "criterion_id":"technical","result_state":"assessed","rating_id":rating,"numeric_value":"75",
        "evidence_refs":([{"artifact_id":"art_1","artifact_version_id":"ver_1","submission_id":"sub_1",
                           "locator":{"kind":"line_range","start_line":1,"end_line":2}}] if refs else []),
    }

MAPPING={"competency_id":"comp_debugging","definition_version":1,"mapping_version":1,"sub_competency_id":"",
         "context_tags":{"career_family":"software_engineering","role_family":"software_engineering",
                         "scenario_pack_id":"sp_demo_software_engineering","task_category":"investigative",
                         "domain":"software_engineering","work_context":"bug_reproduction"}}

class Phase7EvidenceTests(unittest.TestCase):
    def test_completed_assessment_creates_exact_lineage_contribution(self):
        row=derive_evidence_contribution(assessment=assessment(),criterion=criterion(),mapping=MAPPING,assistance_level=0)
        self.assertIsNotNone(row)
        self.assertEqual(row["competency_id"],"comp_debugging")
        self.assertEqual(row["mapping_version"],1)
        self.assertEqual(row["demonstrated_level"],"independent")
        self.assertEqual(row["evidence_strength"],"strong")

    def test_incomplete_missing_reference_and_not_yet_fail_closed(self):
        self.assertIsNone(derive_evidence_contribution(assessment=assessment("assessing"),criterion=criterion(),mapping=MAPPING,assistance_level=0))
        self.assertIsNone(derive_evidence_contribution(assessment=assessment(),criterion=criterion(refs=False),mapping=MAPPING,assistance_level=0))
        negative=derive_evidence_contribution(assessment=assessment(),criterion=criterion("not_yet"),mapping=MAPPING,assistance_level=0)
        self.assertEqual(negative["demonstrated_level"],"not_demonstrated")


    def test_unknown_mapping_and_invalid_assistance_fail_closed(self):
        self.assertIsNone(
            derive_evidence_contribution(
                assessment=assessment(),criterion=criterion(),mapping={},assistance_level=0
            )
        )
        self.assertIsNone(
            derive_evidence_contribution(
                assessment=assessment(),criterion=criterion(),mapping=MAPPING,assistance_level=6
            )
        )

    def test_broken_lineage_creates_no_evidence(self):
        bad=criterion(); bad["evidence_refs"][0]["artifact_version_id"]="other"
        self.assertIsNone(derive_evidence_contribution(assessment=assessment(),criterion=bad,mapping=MAPPING,assistance_level=0))

    def test_assisted_meets_is_applied_with_support_not_independent(self):
        row=derive_evidence_contribution(assessment=assessment(),criterion=criterion(),mapping=MAPPING,assistance_level=4)
        self.assertEqual(row["demonstrated_level"],"applied_with_support")
        self.assertEqual(row["assistance_context"]["label"],"Substantial coaching used")


    def test_physical_simulation_evidence_is_explicitly_limited_and_not_strong(self):
        mapping={**MAPPING,"context_metadata":{"physical":True}}
        row=derive_evidence_contribution(
            assessment=assessment(),criterion=criterion(),mapping=mapping,assistance_level=0
        )
        self.assertEqual(row["evidence_strength"],"supporting")
        self.assertTrue(row["strength_factors"]["physical_simulation_limitation"])
        self.assertTrue(any("physical or manual competence" in value for value in row["limitations"]))

    def test_migration_enforces_idempotency_and_immutability(self):
        sql=(ROOT/"cloudflare/migrations/0013_virtual_internship_phase7_passport.sql").read_text()
        self.assertIn("UNIQUE (learner_id, assessment_id, criterion_id, competency_id, definition_version, mapping_version, evidence_ruleset_version)",sql)
        self.assertIn("mapping_version INTEGER NOT NULL",sql)
        self.assertIn("trg_competency_evidence_no_update",sql)
        self.assertIn("ON DELETE RESTRICT",sql)
        self.assertNotIn("chain_of_thought",sql.lower())

if __name__=="__main__": unittest.main()
