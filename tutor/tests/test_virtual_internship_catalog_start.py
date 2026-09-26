from __future__ import annotations

import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
INDEX=ROOT/"cloudflare/src/index.ts"
CATALOG=ROOT/"cloudflare/src/virtual_internship_phase10.ts"
ROUTER=ROOT/"railway/murikah_virtual_internship.py"


class Phase10CatalogStartTests(unittest.TestCase):
    def test_browser_start_requires_exact_reviewed_scenario_version(self):
        source=ROUTER.read_text(encoding="utf-8")
        self.assertIn("scenario_version_id: str = Field",source)
        self.assertIn("internship_catalog_detail(",source)
        self.assertIn("body.scenario_version_id",source)
        self.assertIn("scenario_version_id=body.scenario_version_id",source)

    def test_worker_revalidates_catalog_authority_and_completion_policy(self):
        source=CATALOG.read_text(encoding="utf-8")
        for marker in (
            "resolveCatalogStartAuthority",
            "scenario_version_required",
            "scenario_version_retired",
            "scenario_content_integrity_failed",
            "catalog_authority_mismatch",
            "completion_policy_missing",
            "scenario_completion_policies",
        ):
            self.assertIn(marker,source)

    def test_phase1_start_remains_idempotent_and_blocks_parallel_workspaces(self):
        source=INDEX.read_text(encoding="utf-8")
        self.assertIn("start_request_id",source)
        self.assertIn("active_internship_exists",source)
        self.assertIn("status = 'active' LIMIT 1",source)
        self.assertIn("qualifying ? 1 : 0",source)
        self.assertIn("resolveCatalogStartAuthority",source)

    def test_retirement_blocks_new_catalog_starts_without_rewriting_history(self):
        source=CATALOG.read_text(encoding="utf-8")
        self.assertIn("scenario_version_retired",source)
        self.assertIn("catalog_state='retired'",source)
        self.assertNotIn("DELETE FROM internship_instances",source)


if __name__=="__main__":unittest.main()
