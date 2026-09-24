import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

from virtual_internship.passport.export import build_passport_export,SIMULATION_DISCLOSURE

class Phase7ExportTests(unittest.TestCase):
    def test_export_is_traceable_private_evidence_not_completion_credential(self):
        result=build_passport_export(
            passport={"competencies":[{"competency_id":"comp_x","current_level":"developing"}]},
            evidence=[{"id":"ev_1","competency_id":"comp_x","definition_version":1,"internship_id":"vi_1",
                       "scenario_pack_id":"sp","scenario_version_id":"sv","task_id":"task","artifact_id":"art",
                       "artifact_version_id":"ver","submission_id":"sub","assessment_id":"asm","criterion_id":"c",
                       "demonstrated_level":"developing","evidence_strength":"supporting","assistance_level":2,
                       "transfer_context":{},"limitations":[],"evidence_ruleset_version":"phase7-evidence-strength-v1","created_at":10,
                       "provider_secret":"never","chain_of_thought":"never","artifact_content":"never"}],
            definitions=[{"competency_id":"comp_x","definition_version":1,"name":"X","description":"X","domain":"test","level_framework_version":"phase7-levels-v1"}],
            exported_at=20,
        )
        dumped=json.dumps(result).lower()
        self.assertEqual(result["simulation_disclosure"],SIMULATION_DISCLOSURE)
        self.assertIn('"evidence_id": "ev_1"',dumped)
        self.assertNotIn("provider_secret",dumped)
        self.assertNotIn("chain_of_thought",dumped)
        self.assertNotIn("artifact_content",dumped)
        self.assertNotIn("completion certificate",json.dumps(result["competencies"]).lower())

    def test_display_name_is_opt_in(self):
        base=build_passport_export(passport={},evidence=[],definitions=[],include_display_name=False,display_name="Learner",exported_at=1)
        named=build_passport_export(passport={},evidence=[],definitions=[],include_display_name=True,display_name="Learner",exported_at=1)
        self.assertNotIn("learner_display_name",base)
        self.assertEqual(named["learner_display_name"],"Learner")

if __name__=="__main__": unittest.main()
