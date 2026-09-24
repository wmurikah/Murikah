import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORKER=(ROOT/"cloudflare/src/virtual_internship_phase9.ts").read_text()
UI=(ROOT/"railway/MurikahVirtualInternshipWorkspace.tsx.txt").read_text()

class Phase9CompletionLetterTests(unittest.TestCase):
    def test_letter_is_derived_from_same_report_completion_source(self):
        self.assertIn("function buildLetterSource(report: PerformanceReportSourceV1)",WORKER)
        self.assertIn("completion_record_id: report.completion_record_id",WORKER)
        self.assertIn("completion_snapshot_hash: report.completion_snapshot_hash",WORKER)

    def test_letter_is_murikah_issued_and_explicitly_simulated(self):
        self.assertIn("Virtual Internship Completion Letter",WORKER)
        self.assertIn("Issued by Murikah",WORKER)
        self.assertIn("SIMULATION_DISCLOSURE",WORKER)
        self.assertIn("No fictional employer or human executive signature is represented.",WORKER)

    def test_letter_does_not_create_a_certificate_surface(self):
        self.assertIn("Performance Report and Completion Letter become available",UI)
        self.assertIn("No certificate is issued.",UI)
        self.assertNotIn("Generate certificate",UI)

    def test_letter_uses_recorded_dates_role_deliverables_and_competencies(self):
        for marker in (
            "internship_started_at","internship_completed_at","simulated_role",
            "deliverables_completed","competencies","work_categories",
        ):
            self.assertIn(marker,WORKER)

if __name__=="__main__":
    unittest.main()
