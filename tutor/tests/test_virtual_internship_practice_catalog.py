from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.validator import SCENARIOS_ROOT, validate_pack

PRACTICE=("internal-audit-v3","data-analyst-v3","software-engineering-v3")


class Phase10PracticeCatalogTests(unittest.TestCase):
    def test_three_practice_versions_are_demo_nonqualifying_and_catalog_visible(self):
        for name in PRACTICE:
            root=SCENARIOS_ROOT/"demo"/name
            pack=validate_pack(root,verify_hash=True)
            manifest=pack["manifest"]
            catalog=manifest["catalog"]
            self.assertFalse(manifest["qualifying"])
            self.assertEqual(manifest["classification"],"demo")
            self.assertEqual(manifest["mode"],"demo")
            self.assertEqual(catalog["internship_type"],"practice")
            self.assertTrue(catalog["published"])
            self.assertTrue(catalog["catalog_visible"])
            self.assertFalse((root/"completion.json").exists())

    def test_practice_disclosure_is_unambiguous(self):
        for name in PRACTICE:
            manifest=json.loads((SCENARIOS_ROOT/"demo"/name/"manifest.json").read_text(encoding="utf-8"))
            text=manifest["catalog"]["completion_overview"].lower()
            self.assertIn("does not",text)
            self.assertIn("90-day",text)
            self.assertTrue("performance report" in text or "completion" in text)

    def test_historical_demo_versions_are_unchanged_by_phase10_catalog(self):
        historical=("internal-audit","internal-audit-v2","data-analyst","data-analyst-v2","software-engineering","software-engineering-v2")
        for name in historical:
            manifest=json.loads((SCENARIOS_ROOT/"demo"/name/"manifest.json").read_text(encoding="utf-8"))
            self.assertFalse(manifest["qualifying"])
            self.assertEqual(manifest["classification"],"demo")
            self.assertNotIn("catalog",manifest)


if __name__=="__main__":unittest.main()
