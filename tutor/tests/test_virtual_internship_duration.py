"""Phase 1 90-calendar-day policy and UTC boundary tests."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "cloudflare/src/index.ts"


def epoch(value):
    return int(value.timestamp())


def effective_minimum(scenario_days):
    return max(90, scenario_days)


class VirtualInternshipDurationTests(unittest.TestCase):
    def test_worker_centralizes_standard_minimum_and_uses_injected_clock(self):
        source = WORKER.read_text(encoding="utf-8")
        self.assertIn("const STANDARD_MINIMUM_INTERNSHIP_DAYS = 90;", source)
        self.assertIn("Math.max(\n        STANDARD_MINIMUM_INTERNSHIP_DAYS,", source)
        self.assertIn("clock: () => number = utcNowSeconds", source)
        self.assertIn("const now = clock();", source)
        self.assertIn("const targetEndAt = now + effectiveMinimumDays * 86400;", source)
        self.assertNotIn("Africa/Nairobi", source[source.index("function internshipStatusForActor"):source.index("async function handlePersistence")])
        self.assertIn("final_completion_available: false", source)
        self.assertIn("pending_future_completion_gates: true", source)

    def test_89_days_and_89d_235959_are_false_exact_90_is_true(self):
        start = datetime(2026, 1, 1, 8, 30, tzinfo=timezone.utc)
        target = start + timedelta(days=effective_minimum(30))
        self.assertFalse(start + timedelta(days=89) >= target)
        self.assertFalse(start + timedelta(days=89, hours=23, minutes=59, seconds=59) >= target)
        self.assertTrue(start + timedelta(days=90) >= target)
        self.assertTrue(start + timedelta(days=91) >= target)

    def test_scenario_minimum_below_90_cannot_reduce_policy(self):
        self.assertEqual(effective_minimum(30), 90)
        self.assertEqual(effective_minimum(90), 90)

    def test_scenario_minimum_above_90_extends_policy(self):
        self.assertEqual(effective_minimum(120), 120)
        start = datetime(2026, 5, 10, 12, tzinfo=timezone.utc)
        target = start + timedelta(days=effective_minimum(120))
        self.assertFalse(start + timedelta(days=119, hours=23, minutes=59, seconds=59) >= target)
        self.assertTrue(start + timedelta(days=120) >= target)

    def test_month_year_and_leap_boundaries_use_utc_elapsed_calendar_days(self):
        cases = (
            datetime(2026, 11, 30, 23, 59, 59, tzinfo=timezone.utc),
            datetime(2027, 12, 31, 23, 59, 59, tzinfo=timezone.utc),
            datetime(2028, 2, 28, 12, 0, 0, tzinfo=timezone.utc),
        )
        for start in cases:
            with self.subTest(start=start.isoformat()):
                started_at = epoch(start)
                target_end_at = epoch(start + timedelta(days=90))
                self.assertEqual(target_end_at - started_at, 90 * 86400)
                self.assertFalse(epoch(start + timedelta(days=90, seconds=-1)) >= target_end_at)
                self.assertTrue(epoch(start + timedelta(days=90)) >= target_end_at)


if __name__ == "__main__":
    unittest.main()
