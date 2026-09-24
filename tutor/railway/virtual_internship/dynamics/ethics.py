"""Authored professional-judgment and escalation templates for Phase 6."""
from __future__ import annotations

from typing import Any

ETHICS_LIBRARY_VERSION = 1

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
_OPTION_LABELS = {
    "ask_for_clarification": "Ask for clarification before taking action.",
    "document_issue": "Document the issue and relevant evidence.",
    "consult_authored_policy": "Consult the policy supplied by this scenario.",
    "raise_to_authored_supervisor": "Raise the issue to the supervisor role authored for this scenario.",
    "use_authored_ethics_route": "Use the ethics or compliance route authored for this scenario.",
    "decline_inappropriate_action": "Decline the inappropriate action and document the reason.",
}

_SCENARIOS = (
    ("conflict_of_interest", "A potential conflict of interest affects the assigned work."),
    ("soften_material_issue", "A stakeholder pressures the learner to ignore or soften a material issue."),
    ("confidentiality_privacy", "A request creates a confidentiality or privacy concern."),
    ("inappropriate_data_access", "A stakeholder requests access or data use beyond the authored procedure."),
    ("control_override", "A manager requests an undocumented control override."),
    ("questionable_reporting", "A reporting instruction conflicts with the available evidence."),
    ("policy_compliance_conflict", "A business request conflicts with an authored policy or compliance requirement."),
    ("safety_escalation", "A work decision raises a career-appropriate safety or escalation concern."),
    ("client_instruction_conflict", "A client or stakeholder instruction conflicts with the authored procedure."),
)


def _event(category: str, purpose: str) -> dict[str, Any]:
    return {
        "template_id": f"eth_{category}_v1",
        "library_version": ETHICS_LIBRARY_VERSION,
        "category": category,
        "learning_purpose": purpose,
        "allowed_options": list(_OPTION_LABELS),
        "allowed_trigger_types": sorted(_PHASE2_TRIGGERS),
        "allowed_mutation_types": sorted(_PHASE2_MUTATIONS),
        "consequence_authority": "phase2_authored_only",
    }


ETHICS_EVENTS = tuple(_event(category, purpose) for category, purpose in _SCENARIOS)


def validate_ethics_template(template: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "template_id",
        "library_version",
        "category",
        "learning_purpose",
        "allowed_options",
        "allowed_trigger_types",
        "allowed_mutation_types",
        "consequence_authority",
    }
    if not isinstance(template, dict) or set(template) != expected:
        raise ValueError("invalid ethics template")
    if template["library_version"] != ETHICS_LIBRARY_VERSION:
        raise ValueError("unsupported ethics library version")
    if template["consequence_authority"] != "phase2_authored_only":
        raise ValueError("ethics consequences must remain Phase 2 authored")
    if list(template["allowed_options"]) != list(_OPTION_LABELS):
        raise ValueError("ethics response options are invalid")
    if set(template["allowed_trigger_types"]) != _PHASE2_TRIGGERS:
        raise ValueError("ethics trigger authority must remain Phase 2")
    if set(template["allowed_mutation_types"]) != _PHASE2_MUTATIONS:
        raise ValueError("ethics mutation authority must remain Phase 2")
    return template


def validate_authored_option(template: dict[str, Any], option_id: str) -> str:
    validated = validate_ethics_template(template)
    if option_id not in validated["allowed_options"]:
        raise ValueError("unknown authored escalation option")
    return option_id


def compile_phase2_ethics_decision(template: dict[str, Any], *, decision_id: str) -> dict[str, Any]:
    validated = validate_ethics_template(template)
    return {
        "decision_id": decision_id,
        "label": validated["learning_purpose"][:240],
        "options": [
            {"option_id": option_id, "label": _OPTION_LABELS[option_id]}
            for option_id in validated["allowed_options"]
        ],
    }


def compile_phase2_ethics_event(
    template: dict[str, Any],
    *,
    event_id: str,
    authored_sequence: int,
    actor_id: str,
    trigger: dict[str, Any],
    mutation: dict[str, Any],
    message_template_id: str,
) -> dict[str, Any]:
    """Compile an ethics event without allowing the AI layer to author consequences."""
    validated = validate_ethics_template(template)
    trigger_type = str(trigger.get("trigger_type") or "") if isinstance(trigger, dict) else ""
    mutation_type = str(mutation.get("mutation_type") or "") if isinstance(mutation, dict) else ""
    if trigger_type not in validated["allowed_trigger_types"]:
        raise ValueError("unknown Phase 2 ethics trigger")
    if mutation_type not in validated["allowed_mutation_types"]:
        raise ValueError("unknown or irreversible ethics consequence")
    if not actor_id or not message_template_id:
        raise ValueError("ethics event references are incomplete")
    return {
        "event_id": event_id,
        "authored_sequence": int(authored_sequence),
        "event_type": "ethics_escalation",
        "priority": 60,
        "triggers": [dict(trigger)],
        "mutations": [dict(mutation)],
        "message_template_id": message_template_id,
        "actor_ids": [actor_id],
        "once": True,
        "audit_label": f"Ethics/escalation: {validated['category']}"[:180],
        "learning_objective": validated["learning_purpose"][:500],
    }


__all__ = [
    "ETHICS_EVENTS",
    "ETHICS_LIBRARY_VERSION",
    "compile_phase2_ethics_decision",
    "compile_phase2_ethics_event",
    "validate_authored_option",
    "validate_ethics_template",
]
