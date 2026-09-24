"""Career-neutral workplace-dynamics templates that compile into the Phase 2 engine."""
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
_PHASE2_TRIGGERS = {
    "time_elapsed_days",
    "task_state",
    "all_dependencies_completed",
    "fact_equals",
    "prior_event",
    "decision",
}
_PHASE2_MUTATIONS = {
    "reveal_fact",
    "set_mutable_fact",
    "unlock_task",
    "assign_task",
    "adjust_deadline",
    "record_decision",
}
_RESPONSE_LABELS = {
    "clarify": "Ask for clarification before acting.",
    "document": "Document the issue and relevant facts.",
    "prioritize": "Propose an evidence-based priority order.",
    "coordinate": "Coordinate the dependency with the relevant team.",
    "escalate": "Use the scenario-authored escalation route.",
}


def _template(category: str, prompt: str) -> dict[str, Any]:
    return {
        "template_id": f"wd_{category}_v1",
        "library_version": DYNAMICS_LIBRARY_VERSION,
        "category": category,
        "learning_purpose": prompt,
        "trigger_types": sorted(_PHASE2_TRIGGERS),
        "allowed_response_kinds": list(_RESPONSE_LABELS),
        "allowed_mutation_types": sorted(_PHASE2_MUTATIONS),
        "prohibited_consequences": [
            "humiliation",
            "discrimination",
            "sexual_harassment",
            "violence",
            "termination_by_ai",
        ],
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
        "template_id",
        "library_version",
        "category",
        "learning_purpose",
        "trigger_types",
        "allowed_response_kinds",
        "allowed_mutation_types",
        "prohibited_consequences",
    }
    if not isinstance(template, dict) or set(template) != expected:
        raise ValueError("invalid workplace dynamics template")
    if template["library_version"] != DYNAMICS_LIBRARY_VERSION or template["category"] not in _CATEGORIES:
        raise ValueError("unknown workplace dynamics template")
    if set(template["trigger_types"]) != _PHASE2_TRIGGERS:
        raise ValueError("workplace dynamics trigger authority must remain Phase 2")
    if set(template["allowed_mutation_types"]) != _PHASE2_MUTATIONS:
        raise ValueError("workplace dynamics mutation authority must remain Phase 2")
    if list(template["allowed_response_kinds"]) != list(_RESPONSE_LABELS):
        raise ValueError("workplace dynamics response paths are invalid")
    if "termination_by_ai" not in template["prohibited_consequences"]:
        raise ValueError("irreversible AI consequence guardrail is missing")
    return template


def compile_phase2_decision(template: dict[str, Any], *, decision_id: str) -> dict[str, Any]:
    """Compile authored response kinds into a normal Phase 2 decision definition."""
    validated = validate_dynamics_template(template)
    return {
        "decision_id": decision_id,
        "label": validated["learning_purpose"][:240],
        "options": [
            {"option_id": option_id, "label": _RESPONSE_LABELS[option_id]}
            for option_id in validated["allowed_response_kinds"]
        ],
    }


def compile_phase2_event(
    template: dict[str, Any],
    *,
    event_id: str,
    authored_sequence: int,
    actor_id: str,
    trigger: dict[str, Any],
    mutation: dict[str, Any],
    message_template_id: str,
) -> dict[str, Any]:
    """Compile a bounded template using explicitly authored Phase 2 transition data.

    The caller supplies the trigger and consequence. This library never invents a
    canonical state change, and the resulting event is still subject to the full
    Phase 2 schema and semantic-reference validator when installed in a scenario.
    """
    validated = validate_dynamics_template(template)
    trigger_type = str(trigger.get("trigger_type") or "") if isinstance(trigger, dict) else ""
    mutation_type = str(mutation.get("mutation_type") or "") if isinstance(mutation, dict) else ""
    if trigger_type not in validated["trigger_types"]:
        raise ValueError("unknown Phase 2 trigger type")
    if mutation_type not in validated["allowed_mutation_types"]:
        raise ValueError("unknown or irreversible Phase 2 consequence")
    if not actor_id or not message_template_id:
        raise ValueError("workplace dynamics event references are incomplete")
    return {
        "event_id": event_id,
        "authored_sequence": int(authored_sequence),
        "event_type": "workplace_politics",
        "priority": 50,
        "triggers": [dict(trigger)],
        "mutations": [dict(mutation)],
        "message_template_id": message_template_id,
        "actor_ids": [actor_id],
        "once": True,
        "audit_label": f"Workplace dynamics: {validated['category']}"[:180],
        "learning_objective": validated["learning_purpose"][:500],
    }


__all__ = [
    "DYNAMICS_LIBRARY_VERSION",
    "WORKPLACE_DYNAMICS",
    "compile_phase2_decision",
    "compile_phase2_event",
    "validate_dynamics_template",
]
