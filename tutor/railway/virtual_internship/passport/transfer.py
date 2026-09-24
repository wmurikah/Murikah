"""Structured transfer-context helpers; no inference from assessor prose."""
from __future__ import annotations
import json
from typing import Any

TRANSFER_FIELDS=("career_family","role_family","scenario_pack_id","task_category","domain","work_context")

def normalized_transfer_context(value: Any) -> dict[str,str]:
    raw=json.loads(value) if isinstance(value,str) else value
    raw=raw if isinstance(raw,dict) else {}
    return {key:str(raw.get(key) or "").strip() for key in TRANSFER_FIELDS}

def context_identity(value: Any) -> str:
    context=normalized_transfer_context(value)
    return "|".join(context[key] for key in TRANSFER_FIELDS)

def task_context_identity(evidence: dict[str,Any]) -> str:
    return f"{evidence.get('internship_id','')}:{evidence.get('task_id','')}"

def versions_compatible(version_a: int, version_b: int, declarations: list[dict[str,Any]]) -> bool:
    if int(version_a)==int(version_b):
        return True
    for row in declarations:
        if (
            int(row.get("from_version") or 0)==int(version_a)
            and int(row.get("to_version") or 0)==int(version_b)
            and str(row.get("compatibility") or "")=="compatible"
        ):
            return True
    return False
