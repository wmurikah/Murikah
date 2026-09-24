import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.assessment.assistance import assistance_event,events_before_submission

class Phase6AssistanceTests(unittest.TestCase):
    def test_canonical_levels_zero_through_five_are_accepted(self):
        for level in range(6):
            event=assistance_event(
                internship_id="vi_1",task_id="task_1",source="murikah_mentor",
                provenance="system_observed",level=level,category="mentor_guidance",event_time=100+level,
            )
            self.assertEqual(event["assistance_level"],level)

    def test_out_of_range_level_rejected(self):
        with self.assertRaises(Exception):
            assistance_event(internship_id="vi_1",source="murikah_mentor",provenance="system_observed",level=6,category="x",event_time=1)

    def test_post_submission_help_does_not_retroactively_attach(self):
        rows=[
            {"event_time":99,"assistance_level":2},
            {"event_time":101,"assistance_level":5},
        ]
        self.assertEqual(events_before_submission(rows,submitted_at=100),[rows[0]])

    def test_assistance_module_contains_no_score_penalty_formula(self):
        source=(ROOT/"railway/virtual_internship/assessment/assistance.py").read_text()
        self.assertNotIn("score -",source)
        self.assertNotIn("subtract",source.lower())

if __name__=="__main__":unittest.main()
