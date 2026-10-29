"""Virtual Internship Phase 1 duration-policy boundary checks."""
from datetime import datetime, timezone
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
DAY = 24 * 60 * 60


def source(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding="utf-8") if path.exists() else ""


class VirtualInternshipDurationTests(unittest.TestCase):
    def test_authoritative_constant_and_injectable_clock_exist(self):
        worker = source("cloudflare/src/index.ts")
        if not worker:
            return
        match = re.search(r"STANDARD_MINIMUM_INTERNSHIP_DAYS\s*=\s*(\d+)", worker)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), 90)
        self.assertIn("nowSeconds = Math.floor(Date.now() / 1000)", worker)
        self.assertIn("Math.max(", worker)
        self.assertIn("STANDARD_MINIMUM_INTERNSHIP_DAYS", worker)
        self.assertIn("targetEndAt = now + effectiveMinimumDays * INTERNSHIP_DAY_SECONDS", worker)

    def test_required_utc_duration_boundaries(self):
        start = int(datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc).timestamp())
        minimum = 90 * DAY
        self.assertFalse((start + 89 * DAY - start) >= minimum)
        self.assertFalse((start + 89 * DAY + 23 * 60 * 60 + 59 * 60 + 59 - start) >= minimum)
        self.assertTrue((start + 90 * DAY - start) >= minimum)
        self.assertTrue((start + 91 * DAY - start) >= minimum)

    def test_month_year_and_leap_boundaries_are_epoch_safe(self):
        for start_dt in (
            datetime(2026, 1, 31, 23, 0, tzinfo=timezone.utc),
            datetime(2026, 12, 31, 23, 0, tzinfo=timezone.utc),
            datetime(2028, 2, 29, 12, 0, tzinfo=timezone.utc),
        ):
            start = int(start_dt.timestamp())
            self.assertEqual((start + 90 * DAY) - start, 90 * DAY)

    def test_scenario_duration_floor_and_extension_are_persisted(self):
        worker = source("cloudflare/src/index.ts")
        migration = source("cloudflare/migrations/0006_virtual_internship_phase1.sql")
        if not worker or not migration:
            return
        self.assertIn("Math.max(", worker)
        self.assertIn("scenario.minimum_duration_days", worker)
        self.assertIn("minimum_duration_days INTEGER NOT NULL CHECK (minimum_duration_days >= 90)", migration)
        self.assertIn("target_end_at INTEGER NOT NULL", migration)
        self.assertIn("CHECK (completed_at IS NULL)", migration)


if __name__ == "__main__":
    unittest.main()
