import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

from virtual_internship.passport.transfer import context_identity,task_context_identity,versions_compatible

class Phase7TransferTests(unittest.TestCase):
    def test_cross_internship_task_identity_remains_distinct(self):
        self.assertNotEqual(
            task_context_identity({"internship_id":"vi_1","task_id":"task_a"}),
            task_context_identity({"internship_id":"vi_2","task_id":"task_a"}),
        )

    def test_structured_context_not_raw_title_drives_transfer(self):
        value={"career_family":"audit","role_family":"audit","scenario_pack_id":"sp","task_category":"review","domain":"audit","work_context":"investigation","title":"Ignored"}
        self.assertNotIn("Ignored",context_identity(value))

    def test_definition_versions_require_explicit_compatibility(self):
        self.assertTrue(versions_compatible(1,1,[]))
        self.assertFalse(versions_compatible(1,2,[]))
        self.assertTrue(versions_compatible(1,2,[{"from_version":1,"to_version":2,"compatibility":"compatible"}]))

if __name__=="__main__": unittest.main()
