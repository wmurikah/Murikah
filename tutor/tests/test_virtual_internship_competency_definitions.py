import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

from virtual_internship.passport.definitions import (
    LEVELS, LEVEL_LABELS, LEVEL_SEMANTICS, LEVEL_FRAMEWORK_VERSION,
    CompetencyDefinitionError, validate_definition,
)

class Phase7CompetencyDefinitionTests(unittest.TestCase):
    def fixture(self):
        return {
            "competency_id":"comp_test","definition_version":1,
            "level_framework_version":LEVEL_FRAMEWORK_VERSION,
            "evidence_requirements":{
                "emerging":{"min_records":1,"min_candidate":"developing"},
                "independent":{"min_records":2,"min_candidate":"independent","min_independent":1},
            },
        }

    def test_canonical_level_framework_and_semantics(self):
        self.assertEqual(LEVELS,("emerging","developing","applied_with_support","independent","advanced"))
        self.assertEqual(LEVEL_LABELS["applied_with_support"],"Applied with support")
        self.assertIn("low-assistance",LEVEL_SEMANTICS["independent"])

    def test_valid_definition_accepted(self):
        row=validate_definition(self.fixture())
        self.assertEqual(row["definition_version"],1)

    def test_invalid_framework_and_requirements_rejected(self):
        value=self.fixture(); value["level_framework_version"]="invented"
        with self.assertRaises(CompetencyDefinitionError): validate_definition(value)
        value=self.fixture(); value["evidence_requirements"]["advanced"]={"min_records":0}
        with self.assertRaises(CompetencyDefinitionError): validate_definition(value)


    def test_unknown_parent_and_invalid_transfer_or_recency_policy_are_rejected(self):
        value=self.fixture(); value["parent_competency_id"]="comp_missing"
        with self.assertRaises(CompetencyDefinitionError):
            validate_definition(value,known_competency_ids={"comp_test"})
        value=self.fixture(); value["transfer_policy"]={"context_fields":["career_family","unknown_field"]}
        with self.assertRaises(CompetencyDefinitionError):
            validate_definition(value)
        value=self.fixture(); value["recency_policy"]={"expires_after_days":-1}
        with self.assertRaises(CompetencyDefinitionError):
            validate_definition(value)


    def test_seeded_ids_exactly_reuse_authored_v2_scenario_competencies(self):
        authored=set()
        scenario_root=ROOT/"virtual-internship/scenarios/demo"
        for path in sorted(scenario_root.glob("*-v2/tasks.json")):
            for task in json.loads(path.read_text()):
                authored.update(str(value) for value in task.get("competency_refs",[]) if value)
        sql=(ROOT/"cloudflare/migrations/0013_virtual_internship_phase7_passport.sql").read_text()
        seeded=set(re.findall(r"\('(comp_[a-z0-9_]+)',1,",sql))
        self.assertEqual(seeded,authored)

    def test_migration_has_versioned_immutable_definition_authority(self):
        sql=(ROOT/"cloudflare/migrations/0013_virtual_internship_phase7_passport.sql").read_text()
        self.assertIn("PRIMARY KEY (competency_id, definition_version)",sql)
        self.assertIn("trg_competency_definitions_no_update",sql)
        self.assertIn("competency_definition_compatibility",sql)
        self.assertIn("comp_process_understanding",sql)
        self.assertIn("comp_test_reasoning",sql)

if __name__=="__main__": unittest.main()
