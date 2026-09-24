"""Career-neutral deterministic rubric validation and calculation for Phase 6."""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

RUBRIC_SCHEMA_VERSION = 1
RUBRIC_CALCULATION_VERSION = "phase6-weighted-v1"
RUBRIC_WEIGHT_TOTAL = Decimal("100")
RUBRIC_ROUNDING = Decimal("0.01")


class RubricError(ValueError):
    pass


def _decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool):
        raise RubricError(f"{field} must be numeric")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise RubricError(f"{field} must be numeric") from exc
    if not parsed.is_finite():
        raise RubricError(f"{field} must be finite")
    return parsed


def rubric_hash(rubric: dict[str, Any]) -> str:
    normalized = validate_rubric(rubric)
    raw = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def validate_rubric(rubric: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(rubric, dict):
        raise RubricError("rubric must be an object")
    required = {"rubric_id", "schema_version", "title", "purpose", "calculation", "rating_levels", "criteria"}
    allowed = set(required)
    if set(rubric) != allowed:
        raise RubricError("rubric fields are invalid")
    rubric_id = str(rubric.get("rubric_id") or "").strip()
    title = str(rubric.get("title") or "").strip()
    purpose = str(rubric.get("purpose") or "").strip()
    if not rubric_id or len(rubric_id) > 128 or not title or len(title) > 200 or len(purpose) > 1000:
        raise RubricError("rubric identity is invalid")
    if rubric.get("schema_version") != RUBRIC_SCHEMA_VERSION:
        raise RubricError("unsupported rubric schema version")

    calculation = rubric.get("calculation")
    if not isinstance(calculation, dict) or set(calculation) != {"method", "weight_total", "rounding"}:
        raise RubricError("rubric calculation is invalid")
    if calculation.get("method") not in {"weighted_average", "none"}:
        raise RubricError("unsupported rubric calculation method")
    if calculation.get("rounding") != "half_up_2dp":
        raise RubricError("unsupported rubric rounding rule")
    authored_total = _decimal(calculation.get("weight_total"), "weight_total")
    if authored_total != RUBRIC_WEIGHT_TOTAL:
        raise RubricError("weighted rubric weight_total must equal 100")

    levels = rubric.get("rating_levels")
    if not isinstance(levels, list) or not 2 <= len(levels) <= 12:
        raise RubricError("rubric rating_levels are invalid")
    normalized_levels: list[dict[str, Any]] = []
    level_ids: set[str] = set()
    for row in levels:
        if not isinstance(row, dict) or set(row) != {"rating_id", "label", "value"}:
            raise RubricError("rating level is invalid")
        rating_id = str(row.get("rating_id") or "").strip()
        label = str(row.get("label") or "").strip()
        value = _decimal(row.get("value"), f"rating {rating_id} value")
        if not rating_id or rating_id in level_ids or len(rating_id) > 80 or not label or len(label) > 120:
            raise RubricError("rating level identity is invalid")
        if value < 0 or value > 100:
            raise RubricError("rating values must be between 0 and 100")
        level_ids.add(rating_id)
        normalized_levels.append({"rating_id": rating_id, "label": label, "value": str(value.normalize())})

    criteria = rubric.get("criteria")
    if not isinstance(criteria, list) or not 1 <= len(criteria) <= 64:
        raise RubricError("rubric criteria are invalid")
    normalized_criteria: list[dict[str, Any]] = []
    criterion_ids: set[str] = set()
    weight_sum = Decimal("0")
    for row in criteria:
        if not isinstance(row, dict):
            raise RubricError("criterion must be an object")
        required_criterion = {
            "criterion_id", "description", "evidence_expectations",
            "allowed_rating_ids", "deliverable_types", "allow_not_assessed",
        }
        allowed_criterion = required_criterion | {"weight", "uses_assistance_context"}
        if not required_criterion.issubset(row) or not set(row).issubset(allowed_criterion):
            raise RubricError("criterion fields are invalid")
        criterion_id = str(row.get("criterion_id") or "").strip()
        description = str(row.get("description") or "").strip()
        expectations = str(row.get("evidence_expectations") or "").strip()
        has_weight = "weight" in row
        if calculation["method"] == "weighted_average" and not has_weight:
            raise RubricError("weighted rubric criteria require weights")
        weight = _decimal(row.get("weight"), f"criterion {criterion_id} weight") if has_weight else None
        ratings = row.get("allowed_rating_ids")
        deliverables = row.get("deliverable_types")
        if not criterion_id or criterion_id in criterion_ids or len(criterion_id) > 128:
            raise RubricError("criterion identity is invalid")
        if not description or len(description) > 1200 or not expectations or len(expectations) > 1200:
            raise RubricError("criterion description is invalid")
        if weight is not None and weight < 0:
            raise RubricError("criterion weights must be non-negative")
        if not isinstance(ratings, list) or not ratings or len(set(ratings)) != len(ratings):
            raise RubricError("criterion allowed ratings are invalid")
        if any(not isinstance(x, str) or x not in level_ids for x in ratings):
            raise RubricError("criterion references an unknown rating")
        if not isinstance(deliverables, list) or len(set(deliverables)) != len(deliverables):
            raise RubricError("criterion deliverable types are invalid")
        if any(not isinstance(x, str) or not x or len(x) > 64 for x in deliverables):
            raise RubricError("criterion deliverable type is invalid")
        if not isinstance(row.get("allow_not_assessed"), bool):
            raise RubricError("allow_not_assessed must be boolean")
        if "uses_assistance_context" in row and not isinstance(row.get("uses_assistance_context"), bool):
            raise RubricError("uses_assistance_context must be boolean")
        criterion_ids.add(criterion_id)
        if weight is not None:
            weight_sum += weight
        normalized_criterion = {
            "criterion_id": criterion_id,
            "description": description,
            "evidence_expectations": expectations,
            "allowed_rating_ids": list(ratings),
            "deliverable_types": list(deliverables),
            "allow_not_assessed": bool(row["allow_not_assessed"]),
        }
        if weight is not None:
            normalized_criterion["weight"] = str(weight.normalize())
        if "uses_assistance_context" in row:
            normalized_criterion["uses_assistance_context"] = bool(row["uses_assistance_context"])
        normalized_criteria.append(normalized_criterion)
    if calculation["method"] == "weighted_average" and weight_sum != authored_total:
        raise RubricError("criterion weights must total 100")
    return {
        "rubric_id": rubric_id,
        "schema_version": RUBRIC_SCHEMA_VERSION,
        "title": title,
        "purpose": purpose,
        "calculation": {
            "method": calculation["method"],
            "weight_total": "100",
            "rounding": "half_up_2dp",
        },
        "rating_levels": normalized_levels,
        "criteria": normalized_criteria,
    }


def calculate_aggregate(rubric: dict[str, Any], criterion_results: list[dict[str, Any]]) -> str | None:
    normalized = validate_rubric(rubric)
    if normalized["calculation"]["method"] == "none":
        return None
    by_id = {row["criterion_id"]: row for row in criterion_results}
    levels = {row["rating_id"]: Decimal(row["value"]) for row in normalized["rating_levels"]}
    total = Decimal("0")
    for criterion in normalized["criteria"]:
        result = by_id.get(criterion["criterion_id"])
        if not result or result.get("result_state") == "not_assessed":
            return None
        rating_id = str(result.get("rating_id") or "")
        if rating_id not in levels:
            raise RubricError("criterion result uses unknown rating")
        weight = Decimal(criterion["weight"])
        total += weight * levels[rating_id]
    score = (total / RUBRIC_WEIGHT_TOTAL).quantize(RUBRIC_ROUNDING, rounding=ROUND_HALF_UP)
    return format(score, ".2f")


__all__ = [
    "RUBRIC_CALCULATION_VERSION",
    "RUBRIC_SCHEMA_VERSION",
    "RubricError",
    "calculate_aggregate",
    "rubric_hash",
    "validate_rubric",
]
