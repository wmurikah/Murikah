"""Derive immutable competency evidence contributions from Phase 6 records."""
from __future__ import annotations
from typing import Any
from .strength import calculate_evidence_strength, EVIDENCE_STRENGTH_RULESET_VERSION
from .transfer import normalized_transfer_context

ASSISTANCE_LABELS={0:"Independent demonstration",1:"Clarification only",2:"Light coaching used",3:"Moderate coaching used",4:"Substantial coaching used",5:"Solution-level assistance used"}

def demonstrated_candidate(rating_id: str, assistance_level: int) -> str | None:
    rating=str(rating_id or "")
    if rating=="developing":
        return "developing"
    if rating not in {"meets","exceeds"}:
        return None
    return "independent" if int(assistance_level) <= 1 else "applied_with_support"

def derive_evidence_contribution(*, assessment: dict[str,Any], criterion: dict[str,Any],
                                 mapping: dict[str,Any], assistance_level: int,
                                 revision_context: dict[str,Any] | None = None) -> dict[str,Any] | None:
    if str(assessment.get("status") or "")!="completed":
        return None
    if str(criterion.get("result_state") or "")!="assessed":
        return None
    refs=criterion.get("evidence_refs")
    if not isinstance(refs,list) or not refs:
        return None
    candidate=demonstrated_candidate(str(criterion.get("rating_id") or ""),assistance_level)
    if candidate is None:
        return None
    artifact_id=str(assessment.get("artifact_id") or "")
    version_id=str(assessment.get("artifact_version_id") or "")
    submission_id=str(assessment.get("submission_id") or "")
    lineage_valid=bool(artifact_id and version_id and submission_id) and all(
        isinstance(ref,dict)
        and str(ref.get("artifact_id") or "")==artifact_id
        and str(ref.get("artifact_version_id") or "")==version_id
        and str(ref.get("submission_id") or "")==submission_id
        for ref in refs
    )
    if not lineage_valid:
        return None
    strength=calculate_evidence_strength(
        assessment_completed=True,evidence_refs=refs,lineage_valid=True,
        assistance_level=int(assistance_level),
    )
    return {
        "competency_id":str(mapping.get("competency_id") or ""),
        "definition_version":int(mapping.get("definition_version") or 0),
        "sub_competency_id":str(mapping.get("sub_competency_id") or ""),
        "criterion_id":str(criterion.get("criterion_id") or ""),
        "criterion_rating_id":str(criterion.get("rating_id") or ""),
        "criterion_numeric":criterion.get("numeric_value"),
        "demonstrated_level":candidate,
        "assistance_level":int(assistance_level),
        "assistance_context":{"label":ASSISTANCE_LABELS.get(int(assistance_level),"Assistance recorded"),"scale_version":"phase3-assistance-v1"},
        "revision_context":revision_context or {},
        "evidence_strength":strength["strength"],
        "strength_factors":strength["factors"],
        "transfer_context":normalized_transfer_context(mapping.get("context_tags") or mapping.get("context_tags_json") or {}),
        "limitations":[str(x) for x in assessment.get("limitations",[]) if isinstance(x,str)],
        "source_type":"virtual_internship",
        "evidence_ruleset_version":EVIDENCE_STRENGTH_RULESET_VERSION,
    }
