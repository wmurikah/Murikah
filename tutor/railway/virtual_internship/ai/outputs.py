"""Strict structured-output contracts for Phase 3 machine-consumed roles."""
from __future__ import annotations

import json
from typing import Any

from .roles import ASSESSOR_OUTPUT_SCHEMA_VERSION, DIRECTOR_OUTPUT_SCHEMA_VERSION


ASSESSOR_RESULTS = {"met", "partially_met", "not_met", "not_assessed"}
DIRECTOR_PROPOSAL_TYPES = {"select_authored_event", "choose_authored_option"}


class StructuredOutputError(ValueError):
    pass


def validate_assistance_level(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 5:
        raise StructuredOutputError("assistance_level must be an integer from 0 through 5")
    return value


def parse_json_object(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw or raw.startswith("```"):
        raise StructuredOutputError("structured output must be a plain JSON object")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StructuredOutputError("malformed structured output") from exc
    if not isinstance(value, dict):
        raise StructuredOutputError("structured output must be an object")
    return value


def _exact_keys(value: dict[str, Any], allowed: set[str], required: set[str]) -> None:
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise StructuredOutputError(f"missing required fields: {sorted(missing)}")
    if unknown:
        raise StructuredOutputError(f"unknown fields: {sorted(unknown)}")


def validate_assessor_output(
    value: dict[str, Any],
    *,
    allowed_criterion_ids: set[str],
    allowed_evidence_refs: set[str],
) -> dict[str, Any]:
    _exact_keys(value, {"schema_version", "summary", "criteria", "limitations"}, {"schema_version", "summary", "criteria", "limitations"})
    if value["schema_version"] != ASSESSOR_OUTPUT_SCHEMA_VERSION:
        raise StructuredOutputError("unsupported assessor schema version")
    summary = value["summary"]
    limitations = value["limitations"]
    criteria = value["criteria"]
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 2000:
        raise StructuredOutputError("invalid assessor summary")
    if not isinstance(limitations, list) or len(limitations) > 32 or any(not isinstance(x, str) or len(x) > 500 for x in limitations):
        raise StructuredOutputError("invalid assessor limitations")
    if not isinstance(criteria, list) or not criteria or len(criteria) > 64:
        raise StructuredOutputError("invalid assessor criteria")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for item in criteria:
        if not isinstance(item, dict):
            raise StructuredOutputError("criterion result must be an object")
        _exact_keys(item, {"criterion_id", "result", "evidence_refs"}, {"criterion_id", "result", "evidence_refs"})
        criterion_id = item["criterion_id"]
        result = item["result"]
        refs = item["evidence_refs"]
        if criterion_id not in allowed_criterion_ids or criterion_id in seen:
            raise StructuredOutputError("unknown or duplicate criterion_id")
        if result not in ASSESSOR_RESULTS:
            raise StructuredOutputError("invalid assessor result")
        if not isinstance(refs, list) or len(refs) > 64 or len(set(refs)) != len(refs):
            raise StructuredOutputError("invalid evidence_refs")
        if any(not isinstance(ref, str) or ref not in allowed_evidence_refs for ref in refs):
            raise StructuredOutputError("unknown evidence reference")
        if result != "not_assessed" and not refs:
            raise StructuredOutputError("assessed criteria require an evidence reference")
        seen.add(criterion_id)
        normalized.append({"criterion_id": criterion_id, "result": result, "evidence_refs": list(refs)})
    return {
        "schema_version": ASSESSOR_OUTPUT_SCHEMA_VERSION,
        "summary": summary.strip(),
        "criteria": normalized,
        "limitations": list(limitations),
    }


def validate_director_output(
    value: dict[str, Any],
    *,
    allowed_event_ids: set[str],
    allowed_decisions: dict[str, set[str]],
) -> dict[str, Any]:
    proposal_type = value.get("proposal_type")
    if proposal_type not in DIRECTOR_PROPOSAL_TYPES:
        raise StructuredOutputError("invalid director proposal_type")
    if proposal_type == "select_authored_event":
        allowed = {"schema_version", "proposal_type", "event_id", "rationale_summary"}
        required = {"schema_version", "proposal_type", "event_id", "rationale_summary"}
        _exact_keys(value, allowed, required)
        if value["schema_version"] != DIRECTOR_OUTPUT_SCHEMA_VERSION:
            raise StructuredOutputError("unsupported director schema version")
        event_id = value["event_id"]
        if not isinstance(event_id, str) or event_id not in allowed_event_ids:
            raise StructuredOutputError("unknown authored event")
        rationale = value["rationale_summary"]
        if not isinstance(rationale, str) or len(rationale) > 500:
            raise StructuredOutputError("invalid rationale_summary")
        return {
            "schema_version": DIRECTOR_OUTPUT_SCHEMA_VERSION,
            "proposal_type": proposal_type,
            "event_id": event_id,
            "rationale_summary": rationale.strip(),
        }
    allowed = {"schema_version", "proposal_type", "decision_id", "option_id", "rationale_summary"}
    required = set(allowed)
    _exact_keys(value, allowed, required)
    if value["schema_version"] != DIRECTOR_OUTPUT_SCHEMA_VERSION:
        raise StructuredOutputError("unsupported director schema version")
    decision_id = value["decision_id"]
    option_id = value["option_id"]
    if not isinstance(decision_id, str) or not isinstance(option_id, str) or option_id not in allowed_decisions.get(decision_id, set()):
        raise StructuredOutputError("unknown authored decision option")
    rationale = value["rationale_summary"]
    if not isinstance(rationale, str) or len(rationale) > 500:
        raise StructuredOutputError("invalid rationale_summary")
    return {
        "schema_version": DIRECTOR_OUTPUT_SCHEMA_VERSION,
        "proposal_type": proposal_type,
        "decision_id": decision_id,
        "option_id": option_id,
        "rationale_summary": rationale.strip(),
    }


__all__ = [
    "ASSESSOR_RESULTS",
    "DIRECTOR_PROPOSAL_TYPES",
    "StructuredOutputError",
    "parse_json_object",
    "validate_assessor_output",
    "validate_assistance_level",
    "validate_director_output",
]
