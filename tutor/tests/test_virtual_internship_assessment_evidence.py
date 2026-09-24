import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
from virtual_internship.assessment.evidence import EvidenceError,build_text_evidence_packet,evidence_reference_map

class Phase6EvidenceTests(unittest.TestCase):
    def material(self,content="one\ntwo\nthree"):
        return {"artifact_id":"art_1","artifact_version_id":"ver_2","submission_id":"sub_2","extractable":True,"content":content}

    def test_exact_artifact_version_submission_lineage_is_embedded(self):
        packet=build_text_evidence_packet(self.material())
        ref=packet["references"][0]
        self.assertEqual((ref["artifact_id"],ref["artifact_version_id"],ref["submission_id"]),("art_1","ver_2","sub_2"))
        self.assertEqual(ref["locator"],{"kind":"line_range","start_line":1,"end_line":3})

    def test_cross_version_reference_is_rejected(self):
        packet=build_text_evidence_packet(self.material())
        packet["references"][0]["artifact_version_id"]="ver_other"
        with self.assertRaises(EvidenceError):evidence_reference_map(packet)

    def test_cross_artifact_and_submission_references_are_rejected(self):
        packet=build_text_evidence_packet(self.material())
        packet["references"][0]["artifact_id"]="art_other"
        with self.assertRaises(EvidenceError):evidence_reference_map(packet)
        packet=build_text_evidence_packet(self.material())
        packet["references"][0]["submission_id"]="sub_other"
        with self.assertRaises(EvidenceError):evidence_reference_map(packet)

    def test_locator_cannot_claim_lines_outside_supplied_source(self):
        packet=build_text_evidence_packet(self.material())
        packet["references"][0]["locator"]["end_line"]=99
        with self.assertRaises(EvidenceError):evidence_reference_map(packet)

    def test_binary_without_safe_extraction_is_explicitly_limited(self):
        packet=build_text_evidence_packet({**self.material(""),"extractable":False})
        self.assertEqual(packet["references"],[])
        self.assertTrue(packet["limitations"])

    def test_bounded_packet_marks_unseen_lines(self):
        packet=build_text_evidence_packet(self.material("\n".join(str(i) for i in range(3000))))
        self.assertLessEqual(len(packet["references"]),32)
        self.assertTrue(packet["limitations"])

if __name__=="__main__":unittest.main()
