import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.dynamics.ethics import ETHICS_EVENTS,validate_authored_option,validate_ethics_template

class Phase6EthicsTests(unittest.TestCase):
    def test_required_ethics_categories_are_authored(self):
        categories={row["category"] for row in ETHICS_EVENTS}
        self.assertEqual(categories,{
            "conflict_of_interest","soften_material_issue","confidentiality_privacy","inappropriate_data_access",
            "control_override","questionable_reporting","policy_compliance_conflict","safety_escalation",
            "client_instruction_conflict",
        })
        for row in ETHICS_EVENTS:validate_ethics_template(row)

    def test_only_authored_escalation_option_is_accepted(self):
        template=ETHICS_EVENTS[0]
        self.assertEqual(validate_authored_option(template,"document_issue"),"document_issue")
        with self.assertRaises(ValueError):validate_authored_option(template,"invent_a_universal_manager_route")

    def test_consequence_authority_remains_phase2(self):
        self.assertTrue(all(row["consequence_authority"]=="phase2_authored_only" for row in ETHICS_EVENTS))

if __name__=="__main__":unittest.main()
