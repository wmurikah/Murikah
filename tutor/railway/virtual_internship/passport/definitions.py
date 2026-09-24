"""Canonical deterministic Phase 7 Competency Passport definitions."""
from __future__ import annotations
import json
from typing import Any

LEVEL_FRAMEWORK_VERSION = "phase7-levels-v1"
LEVELS = ("emerging","developing","applied_with_support","independent","advanced")
LEVEL_ORDER = {level:index for index,level in enumerate(LEVELS)}

class CompetencyDefinitionError(ValueError):
    pass

def level_at_least(actual: str, required: str) -> bool:
    return actual in LEVEL_ORDER and required in LEVEL_ORDER and LEVEL_ORDER[actual] >= LEVEL_ORDER[required]

def parse_requirements(value: Any) -> dict[str,dict[str,Any]]:
    raw = json.loads(value) if isinstance(value,str) else value
    if not isinstance(raw,dict):
        raise CompetencyDefinitionError("evidence requirements must be an object")
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

def validate_definition(row: dict[str,Any]) -> dict[str,Any]:
    competency_id=str(row.get("competency_id") or "").strip()
    version=int(row.get("definition_version") or 0)
    if not competency_id or version < 1:
        raise CompetencyDefinitionError("stable competency id and positive definition version are required")
    if str(row.get("level_framework_version") or "") != LEVEL_FRAMEWORK_VERSION:
        raise CompetencyDefinitionError("unsupported level framework")
    requirements=parse_requirements(row.get("evidence_requirements") or row.get("evidence_requirements_json") or {})
    return {**row,"competency_id":competency_id,"definition_version":version,"evidence_requirements":requirements}
