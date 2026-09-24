import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.dynamics.ethics import (
    ETHICS_EVENTS,
    compile_phase2_ethics_decision,
    compile_phase2_ethics_event,
    validate_authored_option,
    validate_ethics_template,
)
from virtual_internship.validator import SCENARIOS_ROOT, validate_pack


class Phase6EthicsTests(unittest.TestCase):
    def test_required_ethics_categories_are_authored(self):
        categories={row["category"] for row in ETHICS_EVENTS}
        self.assertEqual(categories,{
            "conflict_of_interest","soften_material_issue","confidentiality_privacy","inappropriate_data_access",
            "control_override","questionable_reporting","policy_compliance_conflict","safety_escalation",
            "client_instruction_conflict",
        })
        for row in ETHICS_EVENTS:
            validate_ethics_template(row)

    def test_only_authored_escalation_option_is_accepted(self):
        template=ETHICS_EVENTS[0]
        self.assertEqual(validate_authored_option(template,"document_issue"),"document_issue")
        with self.assertRaises(ValueError):
            validate_authored_option(template,"invent_a_universal_manager_route")

    def test_ethics_decision_and_event_validate_in_real_phase2_scenario(self):
        source=SCENARIOS_ROOT/"demo"/"internal-audit-v2"
        with tempfile.TemporaryDirectory() as td:
            target=Path(td)/"scenario"
            shutil.copytree(source,target)
            actors=json.loads((target/"actors.json").read_text())
            tasks=json.loads((target/"tasks.json").read_text())
            decisions=json.loads((target/"decisions.json").read_text())
            events=json.loads((target/"events.json").read_text())

            template=ETHICS_EVENTS[1]
            decision=compile_phase2_ethics_decision(template,decision_id="decision_ethics_test")
            decisions.append(decision)
            event=compile_phase2_ethics_event(
                template,
                event_id="event_ethics_test",
                authored_sequence=max(row["authored_sequence"] for row in events)+1,
                actor_id=actors[0]["actor_id"],
                trigger={
                    "trigger_type":"decision",
                    "decision_id":decision["decision_id"],
                    "option_id":"document_issue",
                },
                mutation={
                    "mutation_type":"adjust_deadline",
                    "task_id":tasks[0]["task_id"],
                    "offset_days":0,
                },
                message_template_id="msg_ethics_test",
            )
            events.append(event)
            (target/"decisions.json").write_text(json.dumps(decisions,indent=2)+"\n")
            (target/"events.json").write_text(json.dumps(events,indent=2)+"\n")
            validate_pack(target,verify_hash=False)

    def test_ai_authored_irreversible_ethics_consequence_is_rejected(self):
        template=ETHICS_EVENTS[0]
        with self.assertRaises(ValueError):
            compile_phase2_ethics_event(
                template,
                event_id="event_ethics_bad",
                authored_sequence=1,
                actor_id="actor_test",
                trigger={"trigger_type":"task_state","task_id":"task_test","status":"in_progress"},
                mutation={"mutation_type":"terminate_learner"},
                message_template_id="msg_ethics_bad",
            )

    def test_consequence_authority_remains_phase2(self):
        self.assertTrue(all(row["consequence_authority"]=="phase2_authored_only" for row in ETHICS_EVENTS))


if __name__=="__main__":
    unittest.main()
