import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.dynamics.library import (
    WORKPLACE_DYNAMICS,
    compile_phase2_decision,
    compile_phase2_event,
    validate_dynamics_template,
)
from virtual_internship.validator import SCENARIOS_ROOT, validate_pack


class Phase6WorkplaceDynamicsTests(unittest.TestCase):
    def test_required_bounded_categories_exist(self):
        categories={row["category"] for row in WORKPLACE_DYNAMICS}
        self.assertEqual(categories,{
            "competing_priorities","ownership_disagreement","management_challenge","deadline_pressure",
            "scope_pressure","resource_constraints","incomplete_handover","credit_recognition_tension",
            "stakeholder_resistance","ambiguous_instruction","cross_team_coordination",
        })
        for row in WORKPLACE_DYNAMICS:
            validate_dynamics_template(row)

    def test_library_compiles_into_real_phase2_schema_and_reference_validation(self):
        source=SCENARIOS_ROOT/"demo"/"internal-audit-v2"
        with tempfile.TemporaryDirectory() as td:
            target=Path(td)/"scenario"
            shutil.copytree(source,target)
            actors=json.loads((target/"actors.json").read_text())
            tasks=json.loads((target/"tasks.json").read_text())
            decisions=json.loads((target/"decisions.json").read_text())
            events=json.loads((target/"events.json").read_text())

            template=WORKPLACE_DYNAMICS[0]
            decision=compile_phase2_decision(template,decision_id="decision_dynamic_test")
            decisions.append(decision)
            event=compile_phase2_event(
                template,
                event_id="event_dynamic_test",
                authored_sequence=max(row["authored_sequence"] for row in events)+1,
                actor_id=actors[0]["actor_id"],
                trigger={
                    "trigger_type":"decision",
                    "decision_id":decision["decision_id"],
                    "option_id":decision["options"][0]["option_id"],
                },
                mutation={
                    "mutation_type":"adjust_deadline",
                    "task_id":tasks[0]["task_id"],
                    "offset_days":0,
                },
                message_template_id="msg_dynamic_test",
            )
            events.append(event)
            (target/"decisions.json").write_text(json.dumps(decisions,indent=2)+"\n")
            (target/"events.json").write_text(json.dumps(events,indent=2)+"\n")
            validate_pack(target,verify_hash=False)

            self.assertEqual(event["triggers"][0]["option_id"],decision["options"][0]["option_id"])
            self.assertTrue(event["once"])
            self.assertNotIn("repeatable",event)
            self.assertNotIn("learner_visible",event)

    def test_unknown_or_irreversible_consequence_is_rejected_before_installation(self):
        template=WORKPLACE_DYNAMICS[0]
        with self.assertRaises(ValueError):
            compile_phase2_event(
                template,
                event_id="event_dynamic_bad",
                authored_sequence=1,
                actor_id="actor_test",
                trigger={"trigger_type":"task_state","task_id":"task_test","status":"in_progress"},
                mutation={"mutation_type":"terminate_learner"},
                message_template_id="msg_dynamic_bad",
            )

    def test_irreversible_ai_consequences_are_explicitly_prohibited(self):
        self.assertTrue(all("termination_by_ai" in row["prohibited_consequences"] for row in WORKPLACE_DYNAMICS))


if __name__=="__main__":
    unittest.main()
