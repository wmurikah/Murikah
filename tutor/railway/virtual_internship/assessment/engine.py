"""Strict production assessor validation plus deterministic rubric calculation."""
from __future__ import annotations

from typing import Any

from .evidence import evidence_reference_map
from .rubrics import (
    RUBRIC_CALCULATION_VERSION,
    calculate_aggregate,
    rubric_hash,
    validate_rubric,
)

FORMAL_ASSESSOR_SCHEMA_VERSION = 1
MAX_CRITERION_FEEDBACK = 2400
_BANNED_GLOBAL_JUDGMENTS = (
    "personality",
    "intelligence",
    "mental health",
    "emotionally stable",
    "cultural fit",
    "sexual orientation",
    "ethnicity",
    "religion",
)


class AssessmentValidationError(ValueError):
    pass


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise AssessmentValidationError(f"{label} fields are invalid")


def _authoritative_summary(results: list[dict[str, Any]]) -> str:
    assessed=sum(1 for row in results if row.get("result_state")=="assessed")
    not_assessed=sum(1 for row in results if row.get("result_state")=="not_assessed")
    if not_assessed:
        return (
            f"Formal rubric assessment recorded {assessed} assessed criterion/criteria and "
            f"{not_assessed} not-assessed criterion/criteria. "
            "Criterion-level feedback and evidence references are authoritative."
        )
    return (
        f"Formal rubric assessment recorded {assessed} assessed criterion/criteria. "
        "Criterion-level feedback and evidence references are authoritative."
    )


def _authoritative_limitations(
    evidence_packet: dict[str, Any],
    results: list[dict[str, Any]],
) -> list[str]:
    rows: list[str]=[]
    supplied=evidence_packet.get("limitations")
    if isinstance(supplied,list):
        rows.extend(str(item).strip().replace("—","-") for item in supplied if isinstance(item,str) and item.strip())
    rows.extend(
        str(row.get("limitation") or "").strip().replace("—","-")
        for row in results
        if row.get("result_state")=="not_assessed" and str(row.get("limitation") or "").strip()
    )
    unique: list[str]=[]
    for row in rows:
        if row and row not in unique:
            unique.append(row[:1000])
    return unique[:32]


def validate_and_calculate_assessment(
    value: dict[str, Any],
    *,
    assessment_id: str,
    rubric: dict[str, Any],
    evidence_packet: dict[str, Any],
) -> dict[str, Any]:
    normalized_rubric = validate_rubric(rubric)
    refs = evidence_reference_map(evidence_packet)
    _exact_keys(
        value,
        {"schema_version", "assessment_id", "criterion_results", "overall_summary", "limitations"},
        "assessor output",
    )
    if value.get("schema_version") != FORMAL_ASSESSOR_SCHEMA_VERSION:
        raise AssessmentValidationError("unsupported formal assessor schema version")
    if value.get("assessment_id") != assessment_id:
        raise AssessmentValidationError("assessment correlation id mismatch")
    summary = value.get("overall_summary")
    limitations = value.get("limitations")
    results = value.get("criterion_results")
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 4000:
        raise AssessmentValidationError("overall summary is invalid")
    if not isinstance(limitations, list) or len(limitations) > 32 or any(not isinstance(x, str) or len(x) > 1000 for x in limitations):
        raise AssessmentValidationError("assessment limitations are invalid")
    if not isinstance(results, list):
        raise AssessmentValidationError("criterion results are invalid")

    rubric_criteria = {row["criterion_id"]: row for row in normalized_rubric["criteria"]}
    rating_values = {row["rating_id"]: row["value"] for row in normalized_rubric["rating_levels"]}
    seen: set[str] = set()
    normalized_results: list[dict[str, Any]] = []
    for row in results:
        if not isinstance(row, dict):
            raise AssessmentValidationError("criterion result must be an object")
        _exact_keys(row, {"criterion_id", "rating", "evidence_refs", "feedback", "limitation"}, "criterion result")
        criterion_id = str(row.get("criterion_id") or "")
        if criterion_id not in rubric_criteria or criterion_id in seen:
            raise AssessmentValidationError("unknown or duplicate criterion id")
        criterion = rubric_criteria[criterion_id]
        rating = str(row.get("rating") or "")
        evidence_ids = row.get("evidence_refs")
        feedback = str(row.get("feedback") or "").strip().replace("—", "-")
        limitation = str(row.get("limitation") or "").strip().replace("—", "-")
        if not isinstance(evidence_ids, list) or len(evidence_ids) > 32 or len(set(evidence_ids)) != len(evidence_ids):
            raise AssessmentValidationError("criterion evidence references are invalid")
        if any(not isinstance(ref_id, str) or ref_id not in refs for ref_id in evidence_ids):
            raise AssessmentValidationError("criterion references evidence not supplied to the assessor")
        if len(feedback) > MAX_CRITERION_FEEDBACK or len(limitation) > 2000:
            raise AssessmentValidationError("criterion feedback is too large")
        lowered = f"{feedback} {limitation}".lower()
        if any(term in lowered for term in _BANNED_GLOBAL_JUDGMENTS):
            raise AssessmentValidationError("criterion feedback contains a prohibited global or sensitive judgment")
        if rating == "not_assessed":
            if not criterion["allow_not_assessed"] or not limitation:
                raise AssessmentValidationError("not_assessed requires an allowed explicit limitation")
            result_state = "not_assessed"
            rating_id = ""
            numeric_value = None
        else:
            if rating not in criterion["allowed_rating_ids"] or rating not in rating_values:
                raise AssessmentValidationError("criterion rating is not authored by the rubric")
            if not evidence_ids:
                raise AssessmentValidationError("assessed criterion requires evidence")
            if not feedback:
                raise AssessmentValidationError("assessed criterion requires evidence-grounded feedback")
            result_state = "assessed"
            rating_id = rating
            numeric_value = rating_values[rating]
        seen.add(criterion_id)
        normalized_results.append({
            "criterion_id": criterion_id,
            "result_state": result_state,
            "rating_id": rating_id,
            "numeric_value": numeric_value,
            "feedback": feedback,
            "evidence_refs": [refs[ref_id] for ref_id in evidence_ids],
            "limitation": limitation,
        })
    if seen != set(rubric_criteria):
        raise AssessmentValidationError("all rubric criteria must be returned exactly once")

    aggregate = calculate_aggregate(normalized_rubric, normalized_results)
    authoritative_summary=_authoritative_summary(normalized_results)
    authoritative_limitations=_authoritative_limitations(evidence_packet,normalized_results)
    return {
        "schema_version": FORMAL_ASSESSOR_SCHEMA_VERSION,
        "assessment_id": assessment_id,
        "rubric_id": normalized_rubric["rubric_id"],
        "rubric_schema_version": normalized_rubric["schema_version"],
        "rubric_hash": rubric_hash(normalized_rubric),
        "calculation_version": RUBRIC_CALCULATION_VERSION,
        "aggregate_numeric": aggregate,
        # The model's summary/overall limitations are schema-validated above but
        # are not authoritative persisted findings. Deterministic code derives
        # these fields from validated criterion results and supplied evidence
        # limitations so uncited model prose cannot become assessment truth.
        "overall_summary": authoritative_summary,
        "limitations": authoritative_limitations,
        "criterion_results": normalized_results,
    }


__all__ = [
    "AssessmentValidationError",
    "FORMAL_ASSESSOR_SCHEMA_VERSION",
    "validate_and_calculate_assessment",
]
