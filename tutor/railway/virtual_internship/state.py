"""Server-side Phase 2 canonical scenario-state facade.

All durable authority remains in D1 behind the existing HMAC persistence bridge.
This module deliberately exposes typed operations and no arbitrary state patch.
"""
from __future__ import annotations
from typing import Any
from deeptutor import murikah_persistence

class ScenarioStateService:
    def definition(self, actor_id:str, internship_id:str)->dict[str,Any]:
        return murikah_persistence.scenario_definition_get(actor_id,internship_id)
    def initialize(self, actor_id:str, internship_id:str, *, request_id:str="")->dict[str,Any]:
        return murikah_persistence.scenario_initialize(actor_id,internship_id,request_id=request_id)
    def state(self, actor_id:str, internship_id:str)->dict[str,Any]:
        return murikah_persistence.scenario_state_get(actor_id,internship_id)
    def actor_view(self, actor_id:str, internship_id:str, scenario_actor_id:str)->dict[str,Any]:
        return murikah_persistence.scenario_actor_view(actor_id,internship_id,scenario_actor_id)
    def learner_view(self, actor_id:str, internship_id:str)->dict[str,Any]:
        return murikah_persistence.scenario_learner_view(actor_id,internship_id)
    def transition_task(self, actor_id:str, internship_id:str, task_id:str, target_status:str, *, request_id:str="", expected_revision:int|None=None)->dict[str,Any]:
        return murikah_persistence.scenario_task_transition(actor_id,internship_id,task_id,target_status,request_id=request_id,expected_revision=expected_revision)
    def record_decision(self, actor_id:str, internship_id:str, decision_id:str, option_id:str, *, request_id:str="", expected_revision:int|None=None)->dict[str,Any]:
        return murikah_persistence.scenario_record_decision(actor_id,internship_id,decision_id,option_id,request_id=request_id,expected_revision=expected_revision)
    def evaluate(self, actor_id:str, internship_id:str, *, request_id:str="", expected_revision:int|None=None)->dict[str,Any]:
        return murikah_persistence.scenario_evaluate(actor_id,internship_id,request_id=request_id,expected_revision=expected_revision)

__all__=["ScenarioStateService"]
