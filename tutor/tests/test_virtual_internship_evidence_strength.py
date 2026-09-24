import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

from virtual_internship.passport.strength import calculate_evidence_strength,EVIDENCE_STRENGTH_RULESET_VERSION

REF={"artifact_id":"art_1","artifact_version_id":"ver_1","submission_id":"sub_1","locator":{"kind":"line_range"}}

class Phase7EvidenceStrengthTests(unittest.TestCase):
    def test_strength_is_separate_deterministic_and_versioned(self):
        strong=calculate_evidence_strength(assessment_completed=True,evidence_refs=[REF],lineage_valid=True,assistance_level=0)
        assisted=calculate_evidence_strength(assessment_completed=True,evidence_refs=[REF],lineage_valid=True,assistance_level=3)
        weak=calculate_evidence_strength(assessment_completed=True,evidence_refs=[],lineage_valid=True,assistance_level=0)
        self.assertEqual(strong["strength"],"strong")
        self.assertEqual(assisted["strength"],"supporting")
        self.assertEqual(weak["strength"],"limited")
        self.assertEqual(strong["ruleset_version"],EVIDENCE_STRENGTH_RULESET_VERSION)
        self.assertIn("low_assistance_context",strong["factors"])

    def test_no_model_or_confidence_dependency(self):
        source=(ROOT/"railway/virtual_internship/passport/strength.py").read_text().lower()
        self.assertNotIn("llm",source)
        self.assertNotIn("model_confidence",source)
        self.assertNotIn("87.413",source)

if __name__=="__main__": unittest.main()
