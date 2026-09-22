"""Pure deterministic Phase 2 event evaluator for offline tests and replay verification."""
from __future__ import annotations
import copy, hashlib, json
from typing import Any
from .validator import MAX_CASCADE_DEPTH, ScenarioValidationError
from .task_graph import transition_task, unlock_satisfied

def state_hash(state:dict[str,Any])->str:
    payload=json.dumps(state,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()

def _trigger_ok(trigger:dict[str,Any],pack:dict[str,Any],state:dict[str,Any],started_at:int,now:int)->bool:
    tt=trigger["trigger_type"]
    if tt=="time_elapsed_days":return now>=started_at+trigger["days"]*86400
    if tt=="task_state":return state["tasks"].get(trigger["task_id"])==trigger["status"]
    if tt=="all_dependencies_completed":
        task=next(t for t in pack["tasks"] if t["task_id"]==trigger["task_id"])
        return bool(task["dependencies"]) and all(state["tasks"].get(d)=="completed" for d in task["dependencies"])
    if tt=="fact_equals":return state["facts"][trigger["fact_id"]]["value"]==trigger["expected"]
    if tt=="prior_event":return trigger["event_id"] in state["fired_events"]
    if tt=="decision":return state["decisions"].get(trigger["decision_id"])==trigger["option_id"]
    raise ScenarioValidationError(f"unknown trigger {tt}")

def eligible_events(pack:dict[str,Any],state:dict[str,Any],started_at:int,now:int)->list[dict[str,Any]]:
    out=[]
    for event in pack["events"]:
        if event["once"] and event["event_id"] in state["fired_events"]:continue
        if all(_trigger_ok(t,pack,state,started_at,now) for t in event["triggers"]):out.append(event)
    return sorted(out,key=lambda e:(-e["priority"],e["authored_sequence"],e["event_id"]))

def _apply_mutation(pack:dict[str,Any],state:dict[str,Any],mutation:dict[str,Any])->None:
    mt=mutation["mutation_type"]
    if mt=="reveal_fact":
        fact=state["facts"][mutation["fact_id"]];fact["is_revealed"]=True;fact["learner_revealed"]=True;return
    if mt=="set_mutable_fact":
        definition=next(f for f in pack["facts"] if f["id"]==mutation["fact_id"])
        if definition["mutability"]!="mutable":raise ScenarioValidationError("immutable fact mutation rejected")
        state["facts"][mutation["fact_id"]]["value"]=copy.deepcopy(mutation["value"]);return
    if mt in {"unlock_task","assign_task"}:
        task_id=mutation["task_id"]
        if task_id not in state["tasks"]:raise ScenarioValidationError(f"unknown task {task_id}")
        if state["tasks"][task_id]=="locked":state["tasks"][task_id]="available"
        return
    if mt=="adjust_deadline":
        task_id=mutation["task_id"]
        if task_id not in state["due_at"]:raise ScenarioValidationError(f"unknown task {task_id}")
        state["due_at"][task_id]+=mutation["offset_days"]*86400;return
    if mt=="record_decision":
        state["decisions"][mutation["decision_id"]]=mutation["option_id"];return
    raise ScenarioValidationError(f"unknown mutation {mt}")

def initialize_state(pack:dict[str,Any],started_at:int)->dict[str,Any]:
    from .knowledge import initial_runtime_facts
    from .task_graph import initial_task_states
    return {"revision":0,"facts":initial_runtime_facts(pack),"tasks":initial_task_states(pack),
            "due_at":{t["task_id"]:started_at+t["due_policy"]["days"]*86400 for t in pack["tasks"]},
            "fired_events":[],"decisions":{},"audit":[{"revision":0,"type":"scenario_initialized"}]}

def complete_task(pack:dict[str,Any],state:dict[str,Any],task_id:str)->dict[str,Any]:
    next_state=copy.deepcopy(state)
    if next_state["tasks"].get(task_id)=="available":next_state["tasks"]=transition_task(next_state["tasks"],task_id,"in_progress")
    next_state["tasks"]=transition_task(next_state["tasks"],task_id,"completed")
    next_state["tasks"],unlocked=unlock_satisfied(pack["tasks"],next_state["tasks"])
    next_state["revision"]+=1;next_state["audit"].append({"revision":next_state["revision"],"type":"task_completed","task_id":task_id,"unlocked":unlocked})
    return next_state

def record_decision(pack:dict[str,Any],state:dict[str,Any],decision_id:str,option_id:str)->dict[str,Any]:
    decision=next((d for d in pack["decisions"] if d["decision_id"]==decision_id),None)
    if decision is None or option_id not in {o["option_id"] for o in decision["options"]}:raise ScenarioValidationError("unknown decision option")
    next_state=copy.deepcopy(state)
    if decision_id in next_state["decisions"] and next_state["decisions"][decision_id]!=option_id:raise ScenarioValidationError("decision already recorded")
    next_state["decisions"][decision_id]=option_id
    if decision_id not in state["decisions"]:
        next_state["revision"]+=1;next_state["audit"].append({"revision":next_state["revision"],"type":"decision_recorded","decision_id":decision_id,"option_id":option_id})
    return next_state

def evaluate_events(pack:dict[str,Any],state:dict[str,Any],started_at:int,now:int,max_depth:int=MAX_CASCADE_DEPTH)->tuple[dict[str,Any],list[str]]:
    next_state=copy.deepcopy(state); fired=[]; depth=0
    while True:
        eligible=eligible_events(pack,next_state,started_at,now)
        if not eligible:break
        if depth>=max_depth:raise ScenarioValidationError("event cascade depth exceeded")
        event=eligible[0]
        for mutation in event["mutations"]:_apply_mutation(pack,next_state,mutation)
        next_state["tasks"],unlocked=unlock_satisfied(pack["tasks"],next_state["tasks"])
        next_state["fired_events"].append(event["event_id"])
        next_state["revision"]+=1
        next_state["audit"].append({"revision":next_state["revision"],"type":"event_fired","event_id":event["event_id"],"unlocked":unlocked})
        fired.append(event["event_id"]);depth+=1
    return next_state,fired
