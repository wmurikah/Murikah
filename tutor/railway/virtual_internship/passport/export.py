"""Safe learner-controlled Phase 7 JSON export."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
from .aggregation import PASSPORT_AGGREGATION_RULESET_VERSION

SIMULATION_DISCLOSURE="This evidence derives from Murikah Virtual Internship simulations and is not a completion certificate or claim of employment."

def build_passport_export(*, passport:dict[str,Any], evidence:list[dict[str,Any]],
                          definitions:list[dict[str,Any]], include_display_name:bool=False,
                          display_name:str="", exported_at:int|None=None) -> dict[str,Any]:
    ts=int(exported_at if exported_at is not None else datetime.now(tz=timezone.utc).timestamp())
    safe_evidence=[{
        "evidence_id":str(row.get("id") or ""),
        "competency_id":str(row.get("competency_id") or ""),
        "definition_version":int(row.get("definition_version") or 0),
        "internship_id":str(row.get("internship_id") or ""),
        "scenario_pack_id":str(row.get("scenario_pack_id") or ""),
        "scenario_version_id":str(row.get("scenario_version_id") or ""),
        "task_id":str(row.get("task_id") or ""),
        "artifact_id":str(row.get("artifact_id") or ""),
        "artifact_version_id":str(row.get("artifact_version_id") or ""),
        "submission_id":str(row.get("submission_id") or ""),
        "assessment_id":str(row.get("assessment_id") or ""),
        "criterion_id":str(row.get("criterion_id") or ""),
        "demonstrated_level":str(row.get("demonstrated_level") or ""),
        "evidence_strength":str(row.get("evidence_strength") or ""),
        "assistance_level":int(row.get("assistance_level") or 0),
        "transfer_context":row.get("transfer_context") or {},
        "limitations":row.get("limitations") or [],
        "source_type":"virtual_internship",
        "evidence_ruleset_version":str(row.get("evidence_ruleset_version") or ""),
        "created_at":int(row.get("created_at") or 0),
    } for row in evidence]
    output={
        "schema_version":1,
        "exported_at":ts,
        "simulation_disclosure":SIMULATION_DISCLOSURE,
        "passport_aggregation_ruleset_version":PASSPORT_AGGREGATION_RULESET_VERSION,
        "competency_definitions":[{
            "competency_id":str(row.get("competency_id") or ""),
            "definition_version":int(row.get("definition_version") or 0),
            "name":str(row.get("name") or ""),
            "description":str(row.get("description") or ""),
            "domain":str(row.get("domain") or ""),
            "level_framework_version":str(row.get("level_framework_version") or ""),
        } for row in definitions],
        "competencies":passport.get("competencies") or [],
        "evidence":safe_evidence,
        "limitations":["Virtual simulation evidence does not by itself verify physical/manual competence or real employment performance."],
    }
    if include_display_name and display_name.strip():
        output["learner_display_name"]=display_name.strip()
    return output
