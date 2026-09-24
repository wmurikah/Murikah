import re
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORKER=(ROOT/"cloudflare/src/virtual_internship_phase9.ts").read_text()
ROUTER=(ROOT/"railway/murikah_virtual_internship.py").read_text()

class Phase9DocumentVerificationTests(unittest.TestCase):
    def test_reference_and_second_code_are_high_entropy_and_server_generated(self):
        self.assertIn("'vr_' + randomHex(24)",WORKER)
        self.assertIn("'vc_' + randomHex(16)",WORKER)
        self.assertIn("crypto.getRandomValues",WORKER)
        self.assertNotIn("Math.random",WORKER)
        self.assertIn("verification_code_hash",WORKER)

    def test_public_lookup_is_minimal_and_name_requires_correct_code(self):
        self.assertIn("identity_verified:identityVerified",WORKER)
        self.assertIn("...(identityVerified && learnerName ? {learner_name:learnerName} : {})",WORKER)
        self.assertNotIn("source_payload_json:",WORKER[WORKER.index("async function verify"):])
        self.assertIn("required to reveal the learner name",ROUTER)

    def test_verification_reports_current_superseded_and_integrity_failure(self):
        for marker in ("verification_status:'integrity_failed'","'superseded' : 'current'","valid:status === 'current'"):
            self.assertIn(marker,WORKER)

    def test_verification_page_is_noindex_and_discloses_simulation(self):
        self.assertIn('x-robots-tag":"noindex, nofollow"',ROUTER)
        self.assertIn("Simulation disclosure",ROUTER)
        self.assertIn("does not establish employment",ROUTER)

    def test_reference_format_is_nonsequential_and_contains_no_account_identifier(self):
        self.assertRegex(WORKER,re.compile(r"REFERENCE_ID = /\^vr_\[0-9a-f\]\{48\}\$/"))
        self.assertNotIn("actorId +",WORKER[WORKER.index("const reference"):WORKER.index("const codeHash")])

if __name__=="__main__":
    unittest.main()
