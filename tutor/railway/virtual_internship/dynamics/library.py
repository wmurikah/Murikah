"""Career-neutral workplace-dynamics templates that reuse the Phase 2 event/decision engine."""
from __future__ import annotations

from typing import Any

DYNAMICS_LIBRARY_VERSION = 1

_CATEGORIES = (
    "competing_priorities",
    "ownership_disagreement",
    "management_challenge",
    "deadline_pressure",
    "scope_pressure",
    "resource_constraints",
    "incomplete_handover",
    "credit_recognition_tension",
    "stakeholder_resistance",
    "ambiguous_instruction",
    "cross_team_coordination",
)


def _template(category: str, prompt: str) -> dict[str, Any]:
    return {
        "template_id": f"wd_{category}_v1",
        "library_version": DYNAMICS_LIBRARY_VERSION,
        "category": category,
        "learning_purpose": prompt,
        "trigger_types": ["task_state", "time_elapsed_days", "prior_event"],
        "allowed_response_kinds": ["clarify", "document", "prioritize", "coordinate", "escalate"],
        "allowed_consequences": ["message", "meeting", "deadline_adjustment", "reveal_authored_fact", "record_decision"],
        "prohibited_consequences": ["humiliation", "discrimination", "sexual_harassment", "violence", "termination_by_ai"],
    }


WORKPLACE_DYNAMICS = tuple(
    _template(category, purpose)
    for category, purpose in (
        ("competing_priorities", "Practise transparent prioritisation when two legitimate requests conflict."),
        ("ownership_disagreement", "Clarify responsibility without inventing authority."),
        ("management_challenge", "Defend or revise a work conclusion using evidence."),
        ("deadline_pressure", "Negotiate scope, timing and quality constraints professionally."),
        ("scope_pressure", "Recognise and document scope changes before committing."),
        ("resource_constraints", "Adapt a plan to a bounded resource constraint."),
        ("incomplete_handover", "Identify missing context and seek a traceable handover."),
        ("credit_recognition_tension", "Handle recognition concerns without retaliatory behaviour."),
        ("stakeholder_resistance", "Respond to legitimate resistance with evidence and escalation choices."),
        ("ambiguous_instruction", "Clarify an ambiguous request before irreversible action."),
        ("cross_team_coordination", "Resolve a cross-team dependency through authored roles and options."),
    )
)


def validate_dynamics_template(template: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "template_id", "library_version", "category", "learning_purpose",
        "trigger_types", "allowed_response_kinds", "allowed_consequences", "prohibited_consequences",
    }
    if not isinstance(template, dict) or set(template) != expected:
        raise ValueError("invalid workplace dynamics template")
    if template["library_version"] != DYNAMICS_LIBRARY_VERSION or template["category"] not in _CATEGORIES:
        raise ValueError("unknown workplace dynamics template")
    if "termination_by_ai" not in template["prohibited_consequences"]:
        raise ValueError("irreversible AI consequence guardrail is missing")
    return template


def compile_phase2_event(
    template: dict[str, Any],
    *,
    event_id: str,
    authored_sequence: int,
    actor_id: str,
    task_id: str,
    decision_id: str,
) -> dict[str, Any]:
    validated = validate_dynamics_template(template)
    return {
        "event_id": event_id,
        "authored_sequence": int(authored_sequence),
        "title": validated["learning_purpose"][:160],
        "event_type": "workplace_dynamic",
        "priority": 50,
        "triggers": [{"trigger_type": "task_state", "task_id": task_id, "state": "in_progress"}],
        "mutations": [{"mutation_type": "record_decision", "decision_id": decision_id}],
        "actor_ids": [actor_id],
        "learner_visible": True,
        "repeatable": False,
    }


__all__ = ["DYNAMICS_LIBRARY_VERSION", "WORKPLACE_DYNAMICS", "compile_phase2_event", "validate_dynamics_template"]
