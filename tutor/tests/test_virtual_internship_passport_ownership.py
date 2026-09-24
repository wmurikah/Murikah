import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))

class Phase7OwnershipContractTests(unittest.TestCase):
    def test_phase7_migration_has_private_owner_keys_and_no_public_profile(self):
        sql=(ROOT/"cloudflare/migrations/0013_virtual_internship_phase7_passport.sql").read_text().lower()
        self.assertIn("learner_id text not null",sql)
        self.assertIn("foreign key (learner_id) references tutor_accounts(actor_id) on delete restrict",sql)
        self.assertNotIn("public_profile",sql)
        self.assertNotIn("employability",sql)
        self.assertNotIn("percentile",sql)

    def test_browser_write_restrictions_are_a_release_invariant(self):
        spec=(ROOT/"virtual-internship/README.md").read_text().lower()
        self.assertIn("competency passport",spec)
        migration=(ROOT/"cloudflare/migrations/0013_virtual_internship_phase7_passport.sql").read_text().lower()
        self.assertNotIn("completion_records",migration)
        self.assertNotIn("completion_letter",migration)
        self.assertNotIn("certificate",migration)

if __name__=="__main__": unittest.main()
