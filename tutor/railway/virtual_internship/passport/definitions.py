"""Canonical deterministic Phase 7 Competency Passport definitions."""
from __future__ import annotations
import json
from typing import Any, Iterable

LEVEL_FRAMEWORK_VERSION = "phase7-levels-v1"
LEVELS = ("emerging","developing","applied_with_support","independent","advanced")
LEVEL_ORDER = {level:index for index,level in enumerate(LEVELS)}
LEVEL_LABELS = {
    "emerging": "Emerging",
    "developing": "Developing",
    "applied_with_support": "Applied with support",
    "independent": "Independent",
    "advanced": "Advanced",
}
LEVEL_SEMANTICS = {
    "emerging": "Early demonstrated evidence exists; task exposure alone is not evidence.",
    "developing": "Repeated partial or improving demonstration is supported by evidence.",
    "applied_with_support": "Credible application is demonstrated with material assistance in context.",
    "independent": "Successful performance includes qualifying low-assistance evidence.",
    "advanced": "Repeated independent performance is demonstrated across sufficiently distinct contexts.",
}
TRANSFER_CONTEXT_FIELDS = (
    "career_family","role_family","scenario_pack_id","task_category","domain","work_context",
)

class CompetencyDefinitionError(ValueError):
    pass

def level_at_least(actual: str, required: str) -> bool:
    return actual in LEVEL_ORDER and required in LEVEL_ORDER and LEVEL_ORDER[actual] >= LEVEL_ORDER[required]

def _object(value: Any, label: str) -> dict[str,Any]:
    try:
        raw = json.loads(value) if isinstance(value,str) else value
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CompetencyDefinitionError(f"{label} must be valid JSON") from exc
    if not isinstance(raw,dict):
        raise CompetencyDefinitionError(f"{label} must be an object")
    return raw

def parse_requirements(value: Any) -> dict[str,dict[str,Any]]:
    raw = _object(value, "evidence requirements")
    for level, rules in raw.items():
        if level not in LEVELS or not isinstance(rules,dict):
            raise CompetencyDefinitionError("invalid level evidence requirement")
        if int(rules.get("min_records",0)) < 1:
            raise CompetencyDefinitionError("each configured level needs min_records")
        candidate=str(rules.get("min_candidate") or "")
        if candidate and candidate not in LEVEL_ORDER:
            raise CompetencyDefinitionError("invalid min_candidate")
        for key in ("min_independent","min_task_contexts","min_transfer_contexts"):
            if key in rules and int(rules[key]) < 0:
                raise CompetencyDefinitionError("evidence counts cannot be negative")
    return raw

def parse_transfer_policy(value: Any) -> dict[str,Any]:
    raw = _object(value or {}, "transfer policy")
    fields = raw.get("context_fields", [])
    if fields:
        if not isinstance(fields,list) or not all(isinstance(item,str) for item in fields):
            raise CompetencyDefinitionError("transfer context_fields must be a string array")
        if len(set(fields)) != len(fields) or any(item not in TRANSFER_CONTEXT_FIELDS for item in fields):
            raise CompetencyDefinitionError("transfer context_fields contains an unknown or duplicate field")
    if "advanced_requires_transfer" in raw and not isinstance(raw["advanced_requires_transfer"],bool):
        raise CompetencyDefinitionError("advanced_requires_transfer must be boolean")
    return raw

def parse_recency_policy(value: Any) -> dict[str,Any]:
    raw = _object(value or {}, "recency policy")
    expiry = raw.get("expires_after_days")
    if expiry is not None and int(expiry) <= 0:
        raise CompetencyDefinitionError("expires_after_days must be positive when configured")
    if "conflict_window" in raw and int(raw["conflict_window"]) < 1:
        raise CompetencyDefinitionError("conflict_window must be positive")
    for key in ("latest_strong_not_demonstrated_cap","two_strong_not_demonstrated_cap"):
        if key in raw and str(raw[key]) not in LEVEL_ORDER:
            raise CompetencyDefinitionError(f"{key} must be a canonical level")
    return raw

def validate_definition(
    row: dict[str,Any],
    *,
    known_competency_ids: Iterable[str] | None = None,
) -> dict[str,Any]:
    competency_id=str(row.get("competency_id") or "").strip()
    version=int(row.get("definition_version") or 0)
    if not competency_id or version < 1:
        raise CompetencyDefinitionError("stable competency id and positive definition version are required")
    if str(row.get("level_framework_version") or "") != LEVEL_FRAMEWORK_VERSION:
        raise CompetencyDefinitionError("unsupported level framework")
    parent=str(row.get("parent_competency_id") or "").strip()
    if parent == competency_id:
        raise CompetencyDefinitionError("a competency cannot be its own parent")
    if parent and known_competency_ids is not None and parent not in set(known_competency_ids):
        raise CompetencyDefinitionError("unknown parent competency")
    requirements=parse_requirements(row.get("evidence_requirements") or row.get("evidence_requirements_json") or {})
    transfer=parse_transfer_policy(row.get("transfer_policy") or row.get("transfer_policy_json") or {})
    recency=parse_recency_policy(row.get("recency_policy") or row.get("recency_policy_json") or {})
    return {
        **row,
        "competency_id":competency_id,
        "definition_version":version,
        "parent_competency_id":parent or None,
        "evidence_requirements":requirements,
        "transfer_policy":transfer,
        "recency_policy":recency,
    }
