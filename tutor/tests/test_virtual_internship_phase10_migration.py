from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class Phase10MigrationTests(unittest.TestCase):
    def test_published_template_versions_are_not_left_retired(self):
        sql = (ROOT / "tutor/cloudflare/migrations/0017_virtual_internship_phase10_template_retirement_fix.sql").read_text(encoding="utf-8")
        self.assertIn("UPDATE scenario_template_versions", sql)
        self.assertIn("SET retired_at = NULL", sql)
        self.assertIn("status = 'published'", sql)


if __name__ == "__main__":
    unittest.main()
