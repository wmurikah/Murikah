from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
REGISTRY=ROOT/"virtual-internship/career-families.v1.json"
SCHEMA=ROOT/"virtual-internship/schema/v1/career-family.schema.json"


class Phase10CareerFamilyTests(unittest.TestCase):
    def setUp(self):
        self.registry=json.loads(REGISTRY.read_text(encoding="utf-8"))

    def test_six_versioned_career_families_are_unique_and_active(self):
        rows=self.registry["families"]
        self.assertEqual(self.registry["schema_version"],1)
        self.assertEqual(len(rows),6)
        self.assertEqual(len({row["id"] for row in rows}),6)
        self.assertEqual(len({row["slug"] for row in rows}),6)
        self.assertTrue(all(row["active"] is True for row in rows))
        self.assertEqual({row["slug"] for row in rows},{
            "audit_assurance","data_analytics","software_engineering",
            "cybersecurity","finance","project_operations",
        })

    def test_family_registry_includes_simulation_scope_classification(self):
        for row in self.registry["families"]:
            self.assertIn(row["physical_competency_classification"],{
                "knowledge_work","mixed","physical_skill_limited",
            })
            self.assertIn("physical_competency_limitation_text",row)

    def test_schema_is_strict_and_versioned(self):
        schema=json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(schema["properties"]["schema_version"]["const"],1)
        item=schema["properties"]["families"]["items"]
        self.assertFalse(item["additionalProperties"])
        self.assertIn("physical_competency_classification",item["required"])


if __name__=="__main__":unittest.main()
