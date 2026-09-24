"""Phase 8 completion-policy validation and canonical hashing.

This module validates authored policy. It does not decide learner completion.
Runtime eligibility remains authoritative in the D1 Phase 8 Worker service.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from virtual_internship.passport.definitions import LEVELS

COMPLETION_POLICY_SCHEMA_VERSION = 1
COMPLETION_POLICY_FILENAME = "completion.json"
EVIDENCE_STRENGTHS = ("limited", "supporting", "strong")
REQUIRED_REVIEW_TYPES = ("midpoint",)


class CompletionPolicyError(ValueError):
    pass


def _fail(message: str) -> None:
    raise CompletionPolicyError(message)


def canonical_policy_json(policy: dict[str, Any]) -> str:
    return json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def completion_policy_hash(policy: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_policy_json(policy).encode("utf-8")).hexdigest()


def _ids(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        _fail(f"{label} must be an array of IDs")
    if len(value) != len(set(value)):
        _fail(f"{label} contains duplicate references")
    return list(value)


def _scenario_competencies(pack: dict[str, Any]) -> set[str]:
    known: set[str] = set()
    for task in pack.get("tasks", []):
        for ref in task.get("competency_refs", []):
            if isinstance(ref, str):
                known.add(ref)
            elif isinstance(ref, dict):
                value = str(ref.get("competency_id") or ref.get("id") or "")
                if value:
                    known.add(value)
    return known


def validate_completion_policy(policy: Any, pack: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(policy, dict):
        _fail("completion policy must be an object")
    allowed = {
        "schema_version",
        "required_task_ids",
        "required_review_types",
        "required_competencies",
        "capstone_task_ids",
        "require_final_review",
        "final_review_after_capstone",
    }
    unknown = sorted(set(policy) - allowed)
    if unknown:
        _fail("unknown completion policy fields: " + ", ".join(unknown))
    if int(policy.get("schema_version") or 0) != COMPLETION_POLICY_SCHEMA_VERSION:
        _fail("unsupported completion policy schema version")

    task_ids = {str(task.get("task_id") or "") for task in pack.get("tasks", [])}
    required_tasks = _ids(policy.get("required_task_ids"), "required_task_ids")
    capstones = _ids(policy.get("capstone_task_ids"), "capstone_task_ids")
    for task_id in required_tasks:
        if task_id not in task_ids:
            _fail(f"required_task_ids references unknown task {task_id}")
    for task_id in capstones:
        if task_id not in task_ids:
            _fail(f"capstone_task_ids references unknown task {task_id}")

    review_types = _ids(policy.get("required_review_types"), "required_review_types")
    unknown_reviews = sorted(set(review_types) - set(REQUIRED_REVIEW_TYPES))
    if unknown_reviews:
        _fail("unknown required review type " + unknown_reviews[0])

    if not isinstance(policy.get("require_final_review"), bool):
        _fail("require_final_review must be boolean")
    if not isinstance(policy.get("final_review_after_capstone"), bool):
        _fail("final_review_after_capstone must be boolean")
    if policy["final_review_after_capstone"] and not policy["require_final_review"]:
        _fail("final_review_after_capstone requires require_final_review")
    if policy["final_review_after_capstone"] and not capstones:
        _fail("final_review_after_capstone requires at least one capstone task")

    competencies = policy.get("required_competencies")
    if not isinstance(competencies, list):
        _fail("required_competencies must be an array")
    known_competencies = _scenario_competencies(pack)
    seen: set[tuple[str, int]] = set()
    for row in competencies:
        if not isinstance(row, dict):
            _fail("required competency must be an object")
        allowed_competency = {
            "competency_id",
            "definition_version",
            "minimum_level",
            "minimum_evidence_strength",
            "minimum_evidence_records",
            "minimum_independent_demonstrations",
            "minimum_distinct_contexts",
        }
        unknown = sorted(set(row) - allowed_competency)
        if unknown:
            _fail("unknown required competency fields: " + ", ".join(unknown))
        competency_id = str(row.get("competency_id") or "")
        definition_version = int(row.get("definition_version") or 0)
        key = (competency_id, definition_version)
        if not competency_id or competency_id not in known_competencies:
            _fail(f"required competency {competency_id or '<missing>'} is not authored by this scenario")
        if definition_version < 1:
            _fail("definition_version must be positive")
        if key in seen:
            _fail("duplicate competency requirement")
        seen.add(key)
        if str(row.get("minimum_level") or "") not in LEVELS:
            _fail("invalid competency level")
        if str(row.get("minimum_evidence_strength") or "") not in EVIDENCE_STRENGTHS:
            _fail("invalid evidence-strength value")
        if int(row.get("minimum_evidence_records") or 0) < 1:
            _fail("minimum_evidence_records must be at least 1")
        if int(row.get("minimum_independent_demonstrations") or 0) < 0:
            _fail("minimum_independent_demonstrations cannot be negative")
        if int(row.get("minimum_distinct_contexts") or 0) < 0:
            _fail("minimum_distinct_contexts cannot be negative")

    return policy
