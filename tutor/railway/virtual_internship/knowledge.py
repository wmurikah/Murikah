"""Actor-scoped and learner-safe Phase 2 knowledge views."""
from __future__ import annotations
from typing import Any
from .validator import ScenarioValidationError

def actor_fact_view(pack:dict[str,Any],runtime_facts:dict[str,dict[str,Any]],actor_id:str)->dict[str,Any]:
    actor=next((a for a in pack["actors"] if a["actor_id"]==actor_id and a["active"]),None)
    if actor is None: raise ScenarioValidationError(f"actor {actor_id}: unknown actor")
    definitions={f["id"]:f for f in pack["facts"]}
    allowed=set(actor["knowledge_fact_ids"])
    allowed.update(f["id"] for f in pack["facts"] if f["visibility"]=="public")
    visible={}
    for fact_id in sorted(allowed):
        definition=definitions[fact_id]; runtime=runtime_facts[fact_id]
        if definition["future_only"] and not runtime["is_revealed"]:continue
        visible[fact_id]=runtime["value"]
    return visible

def learner_fact_view(pack:dict[str,Any],runtime_facts:dict[str,dict[str,Any]])->dict[str,Any]:
    return {fid:runtime_facts[fid]["value"] for fid in sorted(runtime_facts) if runtime_facts[fid]["learner_revealed"]}

def initial_runtime_facts(pack:dict[str,Any])->dict[str,dict[str,Any]]:
    result={}
    for fact in pack["facts"]:
        learner_initial=fact["initially_revealed"] and fact["visibility"] in {"public","learner_visible"}
        result[fact["id"]]={"value":fact["value"],"is_revealed":bool(fact["initially_revealed"]),"learner_revealed":bool(learner_initial)}
    return result
