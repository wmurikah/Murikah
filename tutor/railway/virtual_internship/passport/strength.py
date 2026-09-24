"""Transparent deterministic evidence-strength rules for Phase 7."""
from __future__ import annotations
from typing import Any

EVIDENCE_STRENGTH_RULESET_VERSION = "phase7-evidence-strength-v1"
STRENGTH_ORDER = {"limited":0,"supporting":1,"strong":2}

def calculate_evidence_strength(*, assessment_completed: bool, evidence_refs: list[dict[str,Any]],
                                lineage_valid: bool, assistance_level: int,
                                source_type: str = "virtual_internship") -> dict[str,Any]:
    specific_refs=bool(evidence_refs) and all(
        isinstance(ref,dict)
        and bool(ref.get("artifact_id"))
        and bool(ref.get("artifact_version_id"))
        and bool(ref.get("submission_id"))
        and isinstance(ref.get("locator"),dict)
        for ref in evidence_refs
    )
    factors={
        "formal_assessment_completed":bool(assessment_completed),
        "exact_lineage_valid":bool(lineage_valid),
        "specific_evidence_references":specific_refs,
        "low_assistance_context":0 <= int(assistance_level) <= 1,
        "source_type":source_type,
    }
    if not assessment_completed or not lineage_valid or not specific_refs:
        strength="limited"
    elif factors["low_assistance_context"]:
        strength="strong"
    else:
        strength="supporting"
    return {"strength":strength,"factors":factors,"ruleset_version":EVIDENCE_STRENGTH_RULESET_VERSION}
