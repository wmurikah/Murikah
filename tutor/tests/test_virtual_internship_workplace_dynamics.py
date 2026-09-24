import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.dynamics.library import WORKPLACE_DYNAMICS,compile_phase2_event,validate_dynamics_template

class Phase6WorkplaceDynamicsTests(unittest.TestCase):
    def test_required_bounded_categories_exist(self):
        categories={row["category"] for row in WORKPLACE_DYNAMICS}
        self.assertEqual(categories,{
            "competing_priorities","ownership_disagreement","management_challenge","deadline_pressure",
            "scope_pressure","resource_constraints","incomplete_handover","credit_recognition_tension",
            "stakeholder_resistance","ambiguous_instruction","cross_team_coordination",
        })
        for row in WORKPLACE_DYNAMICS:validate_dynamics_template(row)

    def test_library_compiles_to_phase2_authored_event_shape(self):
        event=compile_phase2_event(WORKPLACE_DYNAMICS[0],event_id="event_x",authored_sequence=9,actor_id="actor_1",task_id="task_1",decision_id="decision_1")
        self.assertEqual(event["triggers"][0]["trigger_type"],"task_state")
        self.assertEqual(event["mutations"][0]["mutation_type"],"record_decision")
        self.assertFalse(event["repeatable"])

    def test_irreversible_ai_consequences_are_explicitly_prohibited(self):
        self.assertTrue(all("termination_by_ai" in row["prohibited_consequences"] for row in WORKPLACE_DYNAMICS))

if __name__=="__main__":unittest.main()
