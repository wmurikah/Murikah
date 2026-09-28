from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PRODUCTION=ROOT/"virtual-internship/scenarios/production"
WORKER=ROOT/"cloudflare/src/virtual_internship_phase10.ts"
MIGRATION=ROOT/"cloudflare/migrations/0016_virtual_internship_phase10_catalog.sql"


class Phase10CatalogTests(unittest.TestCase):
    def test_all_six_production_manifests_publish_complete_catalog_metadata(self):
        manifests=[json.loads(path.read_text(encoding="utf-8")) for path in sorted(PRODUCTION.glob("*/manifest.json"))]
        self.assertEqual(len(manifests),6)
        slugs=set()
        for manifest in manifests:
            catalog=manifest["catalog"]
            self.assertTrue(catalog["published"])
            self.assertTrue(catalog["catalog_visible"])
            self.assertEqual(catalog["internship_type"],"qualifying")
            self.assertGreaterEqual(catalog["minimum_duration_days"],90)
            self.assertLessEqual(catalog["weekly_hours_min"],catalog["weekly_hours_max"])
            self.assertTrue(catalog["competencies_developed"])
            self.assertTrue(catalog["sample_responsibilities"])
            self.assertTrue(catalog["deliverables"])
            self.assertNotIn(catalog["catalog_slug"],slugs)
            slugs.add(catalog["catalog_slug"])

    def test_catalog_worker_filters_and_orders_qualifying_before_practice(self):
        source=WORKER.read_text(encoding="utf-8")
        for marker in (
            'url.searchParams.get("q")',
            'url.searchParams.get("career")',
            'url.searchParams.get("sector")',
            'url.searchParams.get("type")',
            'url.searchParams.get("workload")',
            'url.searchParams.get("experience")',
            "CASE ce.internship_type WHEN 'qualifying' THEN 0 ELSE 1 END",
            "LIMIT 100",
        ):
            self.assertIn(marker,source)
        self.assertNotIn("OpenAI",source)
        self.assertNotIn("Gemini",source)

    def test_catalog_storage_has_lookup_indexes_and_one_current_slug(self):
        sql=MIGRATION.read_text(encoding="utf-8")
        for marker in (
            "idx_catalog_visible_type_sort","idx_catalog_family","idx_catalog_sector",
            "idx_catalog_workload","idx_catalog_experience","idx_catalog_slug",
            "idx_catalog_one_current_slug",
        ):
            self.assertIn(marker,sql)


if __name__=="__main__":unittest.main()
