"""Deterministic cross-task/cross-internship Competency Passport aggregation."""
from __future__ import annotations
from typing import Any
from .definitions import LEVELS, LEVEL_ORDER, level_at_least
from .strength import STRENGTH_ORDER
from .transfer import context_identity, task_context_identity

PASSPORT_AGGREGATION_RULESET_VERSION="phase7-passport-aggregation-v1"
TREND_MIN_EVIDENCE=3

def _trend(evidence:list[dict[str,Any]]) -> str:
    if len(evidence)<TREND_MIN_EVIDENCE:
        return "insufficient_evidence"
    ordered=sorted(evidence,key=lambda row:(int(row.get("created_at") or 0),str(row.get("id") or "")))
    values=[({"not_demonstrated":-1,**LEVEL_ORDER}).get(str(row.get("demonstrated_level") or ""),-1) for row in ordered]
    deltas=[b-a for a,b in zip(values,values[1:])]
    if all(delta==0 for delta in deltas):
        return "stable"
    if all(delta>=0 for delta in deltas) and any(delta>0 for delta in deltas):
        return "improving"
    return "mixed"

def _requirements_met(level:str,rules:dict[str,Any],evidence:list[dict[str,Any]]) -> bool:
    min_candidate=str(rules.get("min_candidate") or "developing")
    qualifying=[row for row in evidence if level_at_least(str(row.get("demonstrated_level") or ""),min_candidate)]
    if len(qualifying)<int(rules.get("min_records",1)):
        return False
    independent=sum(1 for row in qualifying if str(row.get("demonstrated_level") or "")=="independent")
    if independent<int(rules.get("min_independent",0)):
        return False
    task_contexts={task_context_identity(row) for row in qualifying}
    if len(task_contexts)<int(rules.get("min_task_contexts",0)):
        return False
    transfer_contexts={context_identity(row.get("transfer_context") or {}) for row in qualifying}
    transfer_contexts.discard("|||||")
    if len(transfer_contexts)<int(rules.get("min_transfer_contexts",0)):
        return False
    return True

def aggregate_competency(*, definition:dict[str,Any], evidence:list[dict[str,Any]]) -> dict[str,Any] | None:
    active=[row for row in evidence if not row.get("revoked") and not row.get("superseded")]
    if not active:
        return None
    rules=definition.get("evidence_requirements") or {}
    positive=[row for row in active if str(row.get("demonstrated_level") or "")!="not_demonstrated"]
    if not positive:
        return None
    current="emerging"
    for level in LEVELS:
        level_rules=rules.get(level)
        if isinstance(level_rules,dict) and _requirements_met(level,level_rules,active):
            current=level
    conflict=definition.get("recency_policy") or {}
    window=max(1,int(conflict.get("conflict_window",2))) if isinstance(conflict,dict) else 2
    recent=sorted(active,key=lambda row:(int(row.get("created_at") or 0),str(row.get("id") or "")))[-window:]
    strong_negative=[row for row in recent if str(row.get("evidence_strength") or "")=="strong" and str(row.get("demonstrated_level") or "")=="not_demonstrated"]
    if len(strong_negative)>=2 and LEVEL_ORDER[current]>LEVEL_ORDER["emerging"]:
        current=str(conflict.get("two_strong_not_demonstrated_cap") or "emerging")
    elif strong_negative and LEVEL_ORDER[current]>LEVEL_ORDER["developing"]:
        current=str(conflict.get("latest_strong_not_demonstrated_cap") or "developing")
    independent=sum(1 for row in active if str(row.get("demonstrated_level") or "")=="independent")
    assisted=len(active)-independent
    task_contexts={task_context_identity(row) for row in active}
    contexts={context_identity(row.get("transfer_context") or {}) for row in active}
    contexts.discard("|||||")
    internships={str(row.get("internship_id") or "") for row in active if row.get("internship_id")}
    strongest=max((str(row.get("evidence_strength") or "limited") for row in active),key=lambda x:STRENGTH_ORDER.get(x,0))
    last=max(int(row.get("created_at") or 0) for row in active)
    next_level=None
    for level in LEVELS[LEVEL_ORDER[current]+1:]:
        if isinstance(rules.get(level),dict):
            next_level=level
            break
    missing=[]
    if next_level:
        r=rules[next_level]
        missing_records=max(0,int(r.get("min_records",0))-len(active))
        missing_independent=max(0,int(r.get("min_independent",0))-independent)
        missing_tasks=max(0,int(r.get("min_task_contexts",0))-len(task_contexts))
        missing_contexts=max(0,int(r.get("min_transfer_contexts",0))-len(contexts))
        if missing_records: missing.append({"kind":"evidence_records","count":missing_records})
        if missing_independent: missing.append({"kind":"independent_demonstrations","count":missing_independent})
        if missing_tasks: missing.append({"kind":"distinct_task_contexts","count":missing_tasks})
        if missing_contexts: missing.append({"kind":"distinct_transfer_contexts","count":missing_contexts})
    explanation={
        "qualifying_evidence_records":len(active),
        "independent_demonstrations":independent,
        "assisted_demonstrations":assisted,
        "distinct_task_contexts":len(task_contexts),
        "distinct_transfer_contexts":len(contexts),
        "strongest_evidence_strength":strongest,
    }
    return {
        "current_level":current,
        "evidence_strength_summary":strongest,
        "evidence_count":len(active),
        "independent_count":independent,
        "assisted_count":assisted,
        "distinct_task_count":len(task_contexts),
        "distinct_context_count":len(contexts),
        "distinct_internship_count":len(internships),
        "trend":_trend(active),
        "last_demonstrated_at":last,
        "explanation":explanation,
        "next_requirements":missing,
        "aggregation_ruleset_version":PASSPORT_AGGREGATION_RULESET_VERSION,
    }
