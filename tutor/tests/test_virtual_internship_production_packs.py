from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.validator import SCENARIOS_ROOT, validate_pack

EXPECTED={
    "internal-audit-v1":("Aster Vale Services Group","Internal Audit Intern"),
    "data-analyst-v1":("Lumen Harbor Insights","Data Analyst Intern"),
    "software-engineering-v1":("Cedarline Systems","Software Engineering Intern"),
    "cybersecurity-analyst-v1":("Orion Ridge Digital","Cybersecurity Analyst Intern"),
    "financial-analyst-v1":("Bluehaven Consumer Group","Financial Analyst Intern"),
    "project-management-v1":("Summit Bridge Programs","Project Management Intern"),
}


class Phase10ProductionPackTests(unittest.TestCase):
    def test_all_six_production_packs_validate_and_are_fictional(self):
        root=SCENARIOS_ROOT/"production"
        self.assertEqual({path.name for path in root.iterdir() if path.is_dir()},set(EXPECTED))
        for name,(company_name,role) in EXPECTED.items():
            pack=validate_pack(root/name,verify_hash=True)
            manifest=pack["manifest"]
            self.assertTrue(manifest["qualifying"])
            self.assertEqual(manifest["classification"],"qualifying")
            self.assertEqual(manifest["mode"],"standard")
            self.assertGreaterEqual(manifest["minimum_duration_days"],90)
            self.assertEqual(pack["company"]["name"],company_name)
            self.assertTrue(pack["company"]["fictional"])
            self.assertEqual(manifest["role_title"],role)
            self.assertIn("fictional",manifest["catalog"]["simulation_disclosure"].lower())

    def test_each_production_pack_has_real_13_week_progression_and_reviews(self):
        root=SCENARIOS_ROOT/"production"
        for name in EXPECTED:
            pack=validate_pack(root/name)
            self.assertGreaterEqual(len(pack["tasks"]),13,name)
            self.assertGreaterEqual(len(pack["actors"]),5,name)
            self.assertGreaterEqual(len(pack["events"]),14,name)
            self.assertTrue(any(task["category"]=="capstone" for task in pack["tasks"]),name)
            self.assertTrue(all(task.get("rubric") for task in pack["tasks"]),name)
            self.assertEqual([task["allowed_mentor_support"] for task in pack["tasks"]][-2:],["none","none"],name)
            types={event["event_type"] for event in pack["events"]}
            self.assertIn("ethics_escalation",types,name)
            self.assertIn("workplace_dynamics",types,name)
            meeting_days={
                trigger["days"]
                for event in pack["events"] if event["event_type"]=="meeting"
                for trigger in event["triggers"] if trigger["trigger_type"]=="time_elapsed_days"
            }
            self.assertIn(45,meeting_days,name)
            self.assertTrue(any(day>=90 for day in meeting_days),name)

    def test_completion_policies_cover_tasks_competencies_capstone_and_final_review(self):
        root=SCENARIOS_ROOT/"production"
        for name in EXPECTED:
            pack=validate_pack(root/name)
            policy=json.loads((root/name/"completion.json").read_text(encoding="utf-8"))
            self.assertEqual(set(policy["required_task_ids"]),{task["task_id"] for task in pack["tasks"]},name)
            self.assertGreaterEqual(len(policy["required_competencies"]),4,name)
            self.assertTrue(policy["capstone_task_ids"],name)
            self.assertTrue(policy["require_final_review"],name)
            self.assertTrue(policy["final_review_after_capstone"],name)


if __name__=="__main__":unittest.main()
