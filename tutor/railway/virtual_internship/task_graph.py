"""Deterministic Phase 2 task graph helpers."""
from __future__ import annotations
from typing import Any
from .validator import ScenarioValidationError, topological_task_order

TASK_TRANSITIONS={
 "available":{"in_progress","cancelled"},
 "in_progress":{"completed","cancelled"},
 "locked":set(),"completed":set(),"cancelled":set(),
}
def initial_task_states(tasks:list[dict[str,Any]])->dict[str,str]:
    topological_task_order(tasks)
    return {t["task_id"]:("locked" if t["dependencies"] else "available") for t in tasks}
def transition_task(states:dict[str,str],task_id:str,target:str)->dict[str,str]:
    if task_id not in states: raise ScenarioValidationError(f"task {task_id}: unknown task")
    current=states[task_id]
    if target==current:return dict(states)
    if target not in TASK_TRANSITIONS.get(current,set()):
        raise ScenarioValidationError(f"task {task_id}: invalid transition {current} -> {target}")
    next_states=dict(states);next_states[task_id]=target;return next_states
def unlock_satisfied(tasks:list[dict[str,Any]],states:dict[str,str])->tuple[dict[str,str],list[str]]:
    result=dict(states); unlocked=[]
    by_id={t["task_id"]:t for t in tasks}
    for task_id in topological_task_order(tasks):
        if result.get(task_id)!="locked":continue
        deps=by_id[task_id]["dependencies"]
        if deps and all(result.get(dep)=="completed" for dep in deps):
            result[task_id]="available";unlocked.append(task_id)
    return result,unlocked
