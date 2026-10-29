from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.institution import InstitutionScenarioError, validate_institution_draft
from virtual_internship.validator import SCENARIOS_ROOT


class Phase10InstitutionScenarioTests(unittest.TestCase):
    def _draft(self):
        root=SCENARIOS_ROOT/"production"/"internal-audit-v1"
        pack={name:json.loads((root/f"{name}.json").read_text(encoding="utf-8")) for name in (
            "manifest","company","facts","actors","tasks","events","decisions",
        )}
        completion=json.loads((root/"completion.json").read_text(encoding="utf-8"))
        return {"pack":pack,"completion_policy":completion}

    def test_canonical_validator_accepts_valid_declarative_institution_pack(self):
        result=validate_institution_draft(self._draft())
        self.assertEqual(result.pack["manifest"]["scenario_version_id"],"sv_internal_audit_qualifying_v1")
        self.assertEqual(len(result.content_hash),64)
        self.assertIsNotNone(result.completion_policy)

    def test_executable_payloads_are_rejected_before_validation(self):
        draft=self._draft()
        draft["python_code"]="print('unsafe')"
        with self.assertRaisesRegex(InstitutionScenarioError,"executable payloads"):
            validate_institution_draft(draft)

    def test_qualifying_under_90_days_fails_closed(self):
        draft=self._draft()
        draft["pack"]["manifest"]["minimum_duration_days"]=30
        draft["pack"]["manifest"]["catalog"]["minimum_duration_days"]=30
        with self.assertRaises(Exception):
            validate_institution_draft(draft)

    def test_publishing_contract_is_admin_only_immutable_and_retry_safe(self):
        worker=(ROOT/"cloudflare/src/virtual_internship_phase10.ts").read_text(encoding="utf-8")
        service=(ROOT/"railway/virtual_internship/institution.py").read_text(encoding="utf-8")
        migration=(ROOT/"cloudflare/migrations/0016_virtual_internship_phase10_catalog.sql").read_text(encoding="utf-8")
        self.assertIn("requireAdmin",worker)
        self.assertIn('row.role === "admin"',worker)
        self.assertIn("published_scenario_immutable",worker)
        self.assertIn("trg_published_institution_draft_immutable",migration)
        self.assertIn("validated draft content changed before publication",service)
        self.assertIn("scenario_definition_install",service)
        self.assertIn("scenario_completion_policy_install",service)
        self.assertIn("internship_catalog_project",service)
        self.assertIn("idempotent_replay",worker)

    def test_new_version_path_does_not_mutate_published_scenario_content(self):
        worker=(ROOT/"cloudflare/src/virtual_internship_phase10.ts").read_text(encoding="utf-8")
        self.assertIn("institution_version_identity_conflict",worker)
        self.assertIn("status === \"published\"",worker)
        self.assertNotIn("UPDATE scenario_version_content SET",worker)


if __name__=="__main__":unittest.main()
