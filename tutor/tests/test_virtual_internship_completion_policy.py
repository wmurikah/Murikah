import copy
import unittest

from virtual_internship.completion.policy import (
    CompletionPolicyError,
    completion_policy_hash,
    validate_completion_policy,
)


PACK = {
    "tasks": [
        {"task_id": "task_core", "competency_refs": ["comp_a"]},
        {"task_id": "task_capstone", "competency_refs": ["comp_a", "comp_b"]},
        {"task_id": "task_optional", "competency_refs": ["comp_b"]},
    ]
}

VALID = {
    "schema_version": 1,
    "required_task_ids": ["task_core"],
    "required_review_types": ["midpoint"],
    "required_competencies": [
        {
            "competency_id": "comp_a",
            "definition_version": 1,
            "minimum_level": "independent",
            "minimum_evidence_strength": "supporting",
            "minimum_evidence_records": 2,
            "minimum_independent_demonstrations": 1,
            "minimum_distinct_contexts": 2,
        }
    ],
    "capstone_task_ids": ["task_capstone"],
    "require_final_review": True,
    "final_review_after_capstone": True,
}


class CompletionPolicyTests(unittest.TestCase):
    def test_valid_policy_is_canonical_and_hash_is_stable(self):
        result = validate_completion_policy(copy.deepcopy(VALID), PACK)
        self.assertEqual(result, VALID)
        self.assertEqual(completion_policy_hash(result), completion_policy_hash(copy.deepcopy(result)))
        self.assertEqual(len(completion_policy_hash(result)), 64)

    def assert_invalid(self, mutate):
        policy = copy.deepcopy(VALID)
        mutate(policy)
        with self.assertRaises(CompletionPolicyError):
            validate_completion_policy(policy, PACK)

    def test_unknown_required_task_rejected(self):
        self.assert_invalid(lambda p: p.__setitem__("required_task_ids", ["missing"]))

    def test_unknown_capstone_task_rejected(self):
        self.assert_invalid(lambda p: p.__setitem__("capstone_task_ids", ["missing"]))

    def test_unknown_competency_rejected(self):
        self.assert_invalid(lambda p: p["required_competencies"][0].__setitem__("competency_id", "comp_missing"))

    def test_invalid_level_rejected(self):
        self.assert_invalid(lambda p: p["required_competencies"][0].__setitem__("minimum_level", "expert"))

    def test_invalid_evidence_strength_rejected(self):
        self.assert_invalid(lambda p: p["required_competencies"][0].__setitem__("minimum_evidence_strength", "excellent"))

    def test_duplicate_task_reference_rejected(self):
        self.assert_invalid(lambda p: p.__setitem__("required_task_ids", ["task_core", "task_core"]))

    def test_duplicate_competency_requirement_rejected(self):
        def duplicate(policy):
            policy["required_competencies"].append(copy.deepcopy(policy["required_competencies"][0]))
        self.assert_invalid(duplicate)

    def test_unknown_review_type_rejected(self):
        self.assert_invalid(lambda p: p.__setitem__("required_review_types", ["midpoint", "manager_signoff"]))

    def test_invalid_schema_version_rejected(self):
        self.assert_invalid(lambda p: p.__setitem__("schema_version", 2))

    def test_after_capstone_rule_cannot_exist_without_final_review(self):
        self.assert_invalid(lambda p: p.__setitem__("require_final_review", False))

    def test_after_capstone_rule_requires_a_capstone(self):
        self.assert_invalid(lambda p: p.__setitem__("capstone_task_ids", []))


if __name__ == "__main__":
    unittest.main()
