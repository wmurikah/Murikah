import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORKER=(ROOT/"cloudflare/src/virtual_internship_phase9.ts").read_text()
MIGRATION=(ROOT/"cloudflare/migrations/0015_virtual_internship_phase9_documents.sql").read_text()

class Phase9EndorsementExtensionTests(unittest.TestCase):
    def test_typed_future_verified_endorsement_extension_exists(self):
        for marker in (
            "export type VerifiedInstitutionEndorsement",
            "institution_id","verified_institution_name","authorized_signer_id",
            "signer_role","endorsement_type","endorsed_at",
            "verification_status: 'verified'","signature_reference",
        ):
            self.assertIn(marker,WORKER)
        self.assertIn("endorsement_json",MIGRATION)

    def test_normal_phase9_sources_have_no_endorsement(self):
        self.assertGreaterEqual(WORKER.count("endorsement: null"),2)

    def test_learner_self_endorsement_fields_are_rejected(self):
        for marker in ("institution_name","signer_name","endorsed","endorsement"):
            self.assertIn("'" + marker + "'",WORKER)
        self.assertIn("invalid_document_generation_request",WORKER)

    def test_renderer_has_no_empty_institution_signature_block(self):
        self.assertNotIn("Institution signature",WORKER)
        self.assertNotIn("University signature",WORKER)

if __name__=="__main__":
    unittest.main()
