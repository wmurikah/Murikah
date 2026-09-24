"""Deterministic cross-task/cross-internship Competency Passport aggregation."""
from __future__ import annotations
from typing import Any
from .definitions import LEVELS, LEVEL_ORDER, level_at_least
from .strength import STRENGTH_ORDER
from .transfer import context_identity, task_context_identity

PASSPORT_AGGREGATION_RULESET_VERSION="phase7-passport-aggregation-v1"
TREND_MIN_EVIDENCE=3
SECONDS_PER_DAY=86400

def _chronological(evidence:list[dict[str,Any]]) -> list[dict[str,Any]]:
    return sorted(evidence,key=lambda row:(int(row.get("created_at") or 0),str(row.get("id") or "")))

def _trend(evidence:list[dict[str,Any]]) -> str:
    if len(evidence)<TREND_MIN_EVIDENCE:
        return "insufficient_evidence"
    values=[({"not_demonstrated":-1,**LEVEL_ORDER}).get(str(row.get("demonstrated_level") or ""),-1) for row in _chronological(evidence)]
    deltas=[b-a for a,b in zip(values,values[1:])]
    if all(delta==0 for delta in deltas):
        return "stable"
    if all(delta>=0 for delta in deltas) and any(delta>0 for delta in deltas):
        return "improving"
    return "mixed"

def _latest_mapping_evidence(evidence:list[dict[str,Any]]) -> list[dict[str,Any]]:
    selected:dict[tuple[str,str,str],dict[str,Any]]={}
    passthrough:list[dict[str,Any]]=[]
    for row in evidence:
        assessment=str(row.get("assessment_id") or "")
        criterion=str(row.get("criterion_id") or "")
        competency=str(row.get("competency_id") or "")
        if not (assessment and criterion and competency):
            passthrough.append(row)
            continue
        key=(assessment,criterion,competency)
        current=selected.get(key)
        if current is None or int(row.get("mapping_version") or 0)>int(current.get("mapping_version") or 0):
            selected[key]=row
    return passthrough+list(selected.values())


def _eligible_by_recency(
    definition:dict[str,Any],
    evidence:list[dict[str,Any]],
    *,
    as_of:int|None,
) -> tuple[list[dict[str,Any]],int]:
    policy=definition.get("recency_policy") or {}
    if not isinstance(policy,dict):
        return evidence,0
    expiry=policy.get("expires_after_days")
    if expiry in (None,"",0,"0") or as_of is None:
        return evidence,0
    days=int(expiry)
    if days<=0:
        return evidence,0
    cutoff=int(as_of)-(days*SECONDS_PER_DAY)
    eligible=[row for row in evidence if int(row.get("created_at") or 0)>=cutoff]
    return eligible,len(evidence)-len(eligible)

def _qualifying_rows(rules:dict[str,Any],evidence:list[dict[str,Any]]) -> list[dict[str,Any]]:
    min_candidate=str(rules.get("min_candidate") or "developing")
    return [
        row for row in evidence
        if level_at_least(str(row.get("demonstrated_level") or ""),min_candidate)
    ]

def _requirements_met(level:str,rules:dict[str,Any],evidence:list[dict[str,Any]]) -> bool:
    qualifying=_qualifying_rows(rules,evidence)
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

def aggregate_competency(
    *,
    definition:dict[str,Any],
    evidence:list[dict[str,Any]],
    as_of:int|None=None,
) -> dict[str,Any] | None:
    historical=_latest_mapping_evidence([
        row for row in evidence if not row.get("revoked") and not row.get("superseded")
    ])
    if not historical:
        return None
    active,expired_count=_eligible_by_recency(definition,historical,as_of=as_of)
    if not active:
        return None
    positive=[row for row in active if str(row.get("demonstrated_level") or "")!="not_demonstrated"]
    if not positive:
        return None

    rules=definition.get("evidence_requirements") or {}
    current="emerging"
    for level in LEVELS:
        level_rules=rules.get(level)
        if isinstance(level_rules,dict) and _requirements_met(level,level_rules,active):
            current=level

    conflict=definition.get("recency_policy") or {}
    window=max(1,int(conflict.get("conflict_window",2))) if isinstance(conflict,dict) else 2
    recent=_chronological(active)[-window:]
    strong_negative=[
        row for row in recent
        if str(row.get("evidence_strength") or "")=="strong"
        and str(row.get("demonstrated_level") or "")=="not_demonstrated"
    ]
    if len(strong_negative)>=2 and LEVEL_ORDER[current]>LEVEL_ORDER["emerging"]:
        current=str(conflict.get("two_strong_not_demonstrated_cap") or "emerging")
    elif strong_negative and LEVEL_ORDER[current]>LEVEL_ORDER["developing"]:
        current=str(conflict.get("latest_strong_not_demonstrated_cap") or "developing")
    if current not in LEVEL_ORDER:
        current="emerging"

    independent=sum(1 for row in active if str(row.get("demonstrated_level") or "")=="independent")
    assisted=sum(
        1 for row in active
        if str(row.get("demonstrated_level") or "") in {"developing","applied_with_support"}
    )
    task_contexts={task_context_identity(row) for row in active}
    contexts={context_identity(row.get("transfer_context") or {}) for row in active}
    contexts.discard("|||||")
    internships={str(row.get("internship_id") or "") for row in active if row.get("internship_id")}
    strongest=max(
        (str(row.get("evidence_strength") or "limited") for row in positive),
        key=lambda x:STRENGTH_ORDER.get(x,0),
    )
    last=max(int(row.get("created_at") or 0) for row in positive)
    strength_distribution={
        name:sum(1 for row in active if str(row.get("evidence_strength") or "")==name)
        for name in STRENGTH_ORDER
    }

    next_level=None
    for level in LEVELS[LEVEL_ORDER[current]+1:]:
        if isinstance(rules.get(level),dict):
            next_level=level
            break
    missing=[]
    if next_level:
        r=rules[next_level]
        qualifying=_qualifying_rows(r,active)
        qualifying_independent=sum(
            1 for row in qualifying if str(row.get("demonstrated_level") or "")=="independent"
        )
        qualifying_tasks={task_context_identity(row) for row in qualifying}
        qualifying_contexts={context_identity(row.get("transfer_context") or {}) for row in qualifying}
        qualifying_contexts.discard("|||||")
        missing_records=max(0,int(r.get("min_records",0))-len(qualifying))
        missing_independent=max(0,int(r.get("min_independent",0))-qualifying_independent)
        missing_tasks=max(0,int(r.get("min_task_contexts",0))-len(qualifying_tasks))
        missing_contexts=max(0,int(r.get("min_transfer_contexts",0))-len(qualifying_contexts))
        if missing_records: missing.append({"kind":"evidence_records","count":missing_records})
        if missing_independent: missing.append({"kind":"independent_demonstrations","count":missing_independent})
        if missing_tasks: missing.append({"kind":"distinct_task_contexts","count":missing_tasks})
        if missing_contexts: missing.append({"kind":"distinct_transfer_contexts","count":missing_contexts})

    explanation={
        "qualifying_evidence_records":len(active),
        "historical_evidence_records":len(historical),
        "expired_evidence_records":expired_count,
        "independent_demonstrations":independent,
        "assisted_demonstrations":assisted,
        "distinct_task_contexts":len(task_contexts),
        "distinct_transfer_contexts":len(contexts),
        "strongest_evidence_strength":strongest,
        "evidence_strength_distribution":strength_distribution,
        "contradictory_records":sum(
            1 for row in active if str(row.get("demonstrated_level") or "")=="not_demonstrated"
        ),
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
