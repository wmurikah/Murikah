from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.ai.roles import (
    INTERNSHIP_CONTEXT_MAX_CHARS, ROLE_POLICIES, VirtualInternshipModelRole, role_policy
)
from virtual_internship.ai.providers import resolve_role_candidates


class AIRoleTests(unittest.TestCase):
    def test_role_vocabulary_and_policies_are_deterministic(self):
        self.assertEqual({r.value for r in VirtualInternshipModelRole},{"actor","mentor","assessor","scenario_director"})
        self.assertEqual(role_policy("actor"),ROLE_POLICIES[VirtualInternshipModelRole.ACTOR])
        self.assertEqual(role_policy("actor").max_attempts,2)
        self.assertEqual(role_policy("mentor").max_attempts,2)
        self.assertTrue(role_policy("assessor").structured_output)
        self.assertTrue(role_policy("scenario_director").structured_output)
        self.assertEqual(INTERNSHIP_CONTEXT_MAX_CHARS,14000)
        with self.assertRaises(ValueError): role_policy("unknown")

    def test_provider_resolution_reuses_allowed_catalog_and_excludes_unauthorized_request(self):
        rows={
            "active":{"profile_id":"shared","model_id":"m1"},
            "options":[
                {"profile_id":"shared","model_id":"m1"},
                {"profile_id":"shared","model_id":"m2"},
            ],
        }
        def resolver(selection):
            return SimpleNamespace(
                provider_name="openai",binding="openai",
                model="vendor/"+selection["model_id"],api_key="secret",
                effective_url="https://example.invalid",base_url="https://example.invalid",
                api_version="",reasoning_effort=None,extra_headers={},
            )
        resolved=resolve_role_candidates(
            role_policy("actor"),
            requested_selection={"profile_id":"private","model_id":"forbidden"},
            allowed_options_getter=lambda:rows,
            config_resolver=resolver,
        )
        self.assertEqual([(r.profile_id,r.model_id) for r in resolved],[("shared","m1"),("shared","m2")])
        self.assertTrue(all(r.model_id!="forbidden" for r in resolved))

    def test_source_uses_existing_murikah_provider_abstractions(self):
        source=(ROOT/"railway/virtual_internship/ai/providers.py").read_text()
        self.assertIn("allowed_llm_options",source)
        self.assertIn("resolve_llm_config_for_selection",source)
        self.assertIn("deeptutor.services.llm",source)
        self.assertNotIn("INTERNSHIP_OPENAI_KEY",source)
        self.assertNotIn("INTERNSHIP_GEMINI_KEY",source)
        self.assertNotIn("Kev",source)


if __name__=="__main__": unittest.main()
